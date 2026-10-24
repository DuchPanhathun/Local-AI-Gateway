// When a provider's limits clear, so callers can wait exactly as long as needed
// instead of guessing: the chat routes answer 429 with a Retry-After header and
// `retry_after` (whole seconds) in the JSON body.

// Every key of a provider was rate limited (429) or past its daily token limit.
// `retryAfter` is the soonest one of them is usable again, when that's known.
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = "RateLimitedError";
  }
}

// Seconds until a rate-limited request may be retried, from the response:
// Retry-After (seconds or an HTTP date), else the x-ratelimit-reset-* headers
// of the limits that are used up (Groq writes "2m59.56s", Cerebras plain
// seconds). If none says it's used up, the soonest reset.
export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) return Math.ceil(Number(retryAfter));
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  const resets: { wait: number; usedUp: boolean }[] = [];
  headers.forEach((value, name) => {
    if (!name.startsWith(RESET)) return;
    const wait = durationSeconds(value);
    const remaining = headers.get(`x-ratelimit-remaining-${name.slice(RESET.length)}`);
    if (wait !== undefined) resets.push({ wait, usedUp: remaining !== null && Number(remaining) <= 0 });
  });
  const usedUp = resets.filter((r) => r.usedUp).map((r) => r.wait);
  if (usedUp.length) return Math.ceil(Math.max(...usedUp));
  if (resets.length) return Math.ceil(Math.min(...resets.map((r) => r.wait)));
  return undefined;
}

const RESET = "x-ratelimit-reset-";
const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

function durationSeconds(value: string): number | undefined {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== text) return undefined;
  return parts.reduce((sum, [, amount, unit]) => sum + Number(amount) * UNIT_SECONDS[unit], 0);
}

// The usage ledger counts days in UTC, so a key past its daily token limit is
// usable again at the next UTC midnight.
export function secondsUntilTomorrowUTC(now = Date.now()): number {
  const day = new Date(now);
  const tomorrow = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
  return Math.ceil((tomorrow - now) / 1000);
}

// Tallies the keys one request skipped for their limits. Once every key has
// been skipped, `error()` is the RateLimitedError to throw in place of the
// last key's error.
export class KeyLimits {
  private skipped = 0;
  private daily = 0;
  private soonest: number | undefined;

  constructor(
    private readonly providerId: string,
    private readonly keyCount: number
  ) {}

  rateLimited(wait: number | undefined): void {
    this.skip(wait);
  }

  pastDailyLimit(now = Date.now()): void {
    this.daily++;
    this.skip(secondsUntilTomorrowUTC(now));
  }

  error(): RateLimitedError | undefined {
    if (this.keyCount === 0 || this.skipped < this.keyCount) return undefined;
    const what =
      this.daily === this.skipped
        ? "is past its daily token limit"
        : this.daily
          ? "is rate limited or past its daily token limit"
          : "hit its rate limit (429)";
    return new RateLimitedError(`Every ${this.providerId} key ${what}.`, this.soonest);
  }

  private skip(wait: number | undefined): void {
    this.skipped++;
    if (wait !== undefined && (this.soonest === undefined || wait < this.soonest)) this.soonest = wait;
  }
}

// Headers for a 429 reply; exposed so browser callers can read Retry-After.
export function retryAfterHeaders(retryAfter: number | undefined): Record<string, string> {
  return retryAfter === undefined
    ? {}
    : { "Retry-After": String(retryAfter), "Access-Control-Expose-Headers": "Retry-After" };
}

// `retry_after` from a local-agent-gateway error body, whose 429s carry it
// when a CLI said when its plan's usage limit resets.
export function bodyRetryAfter(data: unknown): number | undefined {
  const wait = (data as { retry_after?: unknown } | null)?.retry_after;
  return typeof wait === "number" && Number.isFinite(wait) && wait >= 0 ? Math.ceil(wait) : undefined;
}
