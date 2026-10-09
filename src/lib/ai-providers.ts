export type ProviderId = "sea-lion" | "cerebras" | "groq";

type ProviderConfig = {
  baseUrl: string;
  keyEnvPrefix: string;
  defaultModel: string;
  // When set, a key stops being used once its tracked usage for the current
  // UTC day reaches this many tokens, and rotation moves on to the next key.
  dailyTokenLimitPerKey?: number;
};

// All three providers speak the OpenAI chat-completions format, so one call
// path covers them. Free/preview tiers cap requests per minute per key, so we
// round-robin every call across all `<PREFIX>1..21` keys found for the chosen
// provider, and fall through to the next key on a 429 before giving up.
const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  "sea-lion": {
    baseUrl: "https://api.sea-lion.ai/v1",
    keyEnvPrefix: "SEA_LION_API_KEY",
    defaultModel:
      process.env.SEA_LION_MODEL || "aisingapore/Qwen-SEA-LION-v4.5-27B-IT",
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnvPrefix: "CEREBRAS_API_KEY",
    defaultModel: process.env.CEREBRAS_MODEL || "qwen-3.8-27b",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnvPrefix: "GROQ_API_KEY",
    defaultModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    dailyTokenLimitPerKey: Number(process.env.GROQ_DAILY_TOKEN_LIMIT) || 500_000,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

// Published quota reference, for the dashboard only — not enforced here
// (enforcement is the 429-retry + Groq daily-limit skip below). SEA-LION and
// Groq limits are uniform across models ("*"); Cerebras varies per model.
type QuotaLimits = {
  requestsPerMin?: number;
  requestsPerDay?: number;
  tokensPerMin?: number;
  tokensPerDay?: number;
};
const KNOWN_LIMITS: Partial<Record<ProviderId, Record<string, QuotaLimits>>> = {
  "sea-lion": { "*": { requestsPerMin: 10 } },
  cerebras: {
    "qwen-3.8-27b": {
      requestsPerMin: 450,
      requestsPerDay: 648_000,
      tokensPerMin: 450_000,
      tokensPerDay: 648_000_000,
    },
    "gemma-4-31b": {
      requestsPerMin: 5,
      requestsPerDay: 2_400,
      tokensPerMin: 90_000,
      tokensPerDay: 3_000_000,
    },
    "gpt-oss-120b": {
      requestsPerMin: 5,
      requestsPerDay: 2_400,
      tokensPerMin: 90_000,
      tokensPerDay: 3_000_000,
    },
  },
  // Not Groq's real platform limit — this is our own rotation cutoff, shown
  // so the dashboard can render it as a "budget" the same way as the others.
  // The Whisper rows are Groq's published per-key limits for speech-to-text
  // (/api/transcribe), which counts requests, not tokens.
  groq: {
    "*": { tokensPerDay: PROVIDERS.groq.dailyTokenLimitPerKey },
    "whisper-large-v3-turbo": { requestsPerMin: 20, requestsPerDay: 2_000 },
    "whisper-large-v3": { requestsPerMin: 20, requestsPerDay: 2_000 },
  },
};

function limitsFor(providerId: ProviderId, model: string): QuotaLimits | undefined {
  const table = KNOWN_LIMITS[providerId];
  if (!table) return undefined;
  return table[model] ?? table["*"];
}

const MAX_KEYS_PER_PROVIDER = 21;

// One rotation cursor per provider, so calling Cerebras doesn't perturb
// SEA-LION's rotation and vice versa. Best-effort — lives per warm instance.
const cursors = new Map<ProviderId, number>();

// Usage tracking, keyed by "<providerId>:<key>:<model>" — granular by model
// because Cerebras quotas differ per model; SEA-LION/Groq just get one model
// row in practice. Best-effort, in-memory per warm serverless instance: not
// synced across concurrent instances or cold starts. A TODO exists to back
// this with Upstash Redis for exact, persistent counts once that's wired up.
type UsageEntry = {
  day: string;
  dayRequests: number;
  dayTokens: number;
  // recent {timestamp, tokens} pairs, pruned to the last 60s on read
  recent: { ts: number; tokens: number }[];
};
const usage = new Map<string, UsageEntry>();

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(providerId: ProviderId, key: string, model: string): string {
  return `${providerId}:${key}:${model}`;
}

function recordUsage(
  providerId: ProviderId,
  key: string,
  model: string,
  tokens: number
): void {
  const mapKey = usageKey(providerId, key, model);
  const day = todayUTC();
  const now = Date.now();
  const existing = usage.get(mapKey);

  if (!existing || existing.day !== day) {
    usage.set(mapKey, {
      day,
      dayRequests: 1,
      dayTokens: tokens,
      recent: [{ ts: now, tokens }],
    });
    return;
  }

  existing.dayRequests += 1;
  existing.dayTokens += tokens;
  existing.recent.push({ ts: now, tokens });
  // Prune anything older than 60s, and cap the array so memory can't grow
  // unbounded under sustained traffic within a single warm instance.
  const cutoff = now - 60_000;
  existing.recent = existing.recent.filter((e) => e.ts >= cutoff).slice(-500);
}

function getDayTokens(providerId: ProviderId, key: string, model: string): number {
  const entry = usage.get(usageKey(providerId, key, model));
  return entry && entry.day === todayUTC() ? entry.dayTokens : 0;
}

function collectKeys(prefix: string): { name: string; key: string }[] {
  const keys: { name: string; key: string }[] = [];
  for (let i = 1; i <= MAX_KEYS_PER_PROVIDER; i++) {
    const name = `${prefix}${i}`;
    const key = process.env[name];
    if (key) keys.push({ name, key });
  }
  return keys;
}

export type ProviderCallResult = { status: number; data: unknown };

export async function callProvider(
  providerId: ProviderId,
  body: Record<string, unknown>
): Promise<ProviderCallResult> {
  const config = PROVIDERS[providerId];
  const keys = collectKeys(config.keyEnvPrefix);
  if (keys.length === 0) {
    throw new Error(
      `No ${config.keyEnvPrefix}* environment variables are set for provider "${providerId}".`
    );
  }

  const model = (body.model as string | undefined) || config.defaultModel;
  let cursor = cursors.get(providerId) ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const { key } = keys[cursor % keys.length];
    cursor++;

    if (
      config.dailyTokenLimitPerKey &&
      getDayTokens(providerId, key, model) >= config.dailyTokenLimitPerKey
    ) {
      lastError = new Error(
        `${providerId} key hit its daily token limit (${config.dailyTokenLimitPerKey})`
      );
      continue;
    }

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: config.defaultModel, ...body }),
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (res.status === 429) {
      lastError = new Error(`${providerId} key hit its rate limit (429)`);
      continue;
    }

    const data: unknown = await res.json();

    const totalTokens = (data as { usage?: { total_tokens?: number } })?.usage
      ?.total_tokens;
    recordUsage(providerId, key, model, typeof totalTokens === "number" ? totalTokens : 0);

    cursors.set(providerId, cursor);
    return { status: res.status, data };
  }

  cursors.set(providerId, cursor);
  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${providerId} API keys are unavailable right now.`);
}

export type KeyUsageSnapshot = {
  provider: ProviderId;
  keyName: string; // env var name, e.g. "SEA_LION_API_KEY3" — never the raw secret
  model: string;
  requestsLast60s: number;
  tokensLast60s: number;
  requestsToday: number;
  tokensToday: number;
  limits: QuotaLimits | undefined;
};

// Every configured key is included even if it's never been called yet (shown
// with all-zero usage), so the dashboard reflects the full key inventory.
export function getUsageSnapshot(): KeyUsageSnapshot[] {
  const now = Date.now();
  const cutoff = now - 60_000;
  const snapshot: KeyUsageSnapshot[] = [];

  for (const providerId of PROVIDER_IDS) {
    const config = PROVIDERS[providerId];
    const keys = collectKeys(config.keyEnvPrefix);

    for (const { name, key } of keys) {
      // Find every model this key has actually been used with, defaulting to
      // just the provider's default model when it's never been called.
      const modelsUsed = new Set<string>();
      for (const mapKey of usage.keys()) {
        if (mapKey.startsWith(`${providerId}:${key}:`)) {
          modelsUsed.add(mapKey.slice(`${providerId}:${key}:`.length));
        }
      }
      if (modelsUsed.size === 0) modelsUsed.add(config.defaultModel);

      for (const model of modelsUsed) {
        const entry = usage.get(usageKey(providerId, key, model));
        const isToday = entry && entry.day === todayUTC();
        const recent = isToday ? entry.recent.filter((e) => e.ts >= cutoff) : [];

        snapshot.push({
          provider: providerId,
          keyName: name,
          model,
          requestsLast60s: recent.length,
          tokensLast60s: recent.reduce((sum, e) => sum + e.tokens, 0),
          requestsToday: isToday ? entry.dayRequests : 0,
          tokensToday: isToday ? entry.dayTokens : 0,
          limits: limitsFor(providerId, model),
        });
      }
    }
  }

  return snapshot;
}

// Speech-to-text goes to Groq's Whisper, in OpenAI's /audio/transcriptions
// format, over the same GROQ_API_KEY* keys and rotation cursor as chat. Its
// limits are counted per key and per model, so they don't eat into chat's.
const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo";

export type TranscriptionResult = {
  status: number;
  body: string;
  contentType: string;
  // Seconds, as Groq sent it, when every key was rate limited (status 429).
  retryAfter?: string;
};

// `form` is the multipart body for Groq: the audio in `file`, plus any of its
// other fields. The answer is passed back as Groq sent it (JSON, or plain text
// for response_format=text). If every key is rate limited, the result is a 429
// with the shortest wait any key asked for.
export async function transcribeWithGroq(form: FormData): Promise<TranscriptionResult> {
  const config = PROVIDERS.groq;
  const keys = collectKeys(config.keyEnvPrefix);
  if (keys.length === 0) {
    throw new Error(`No ${config.keyEnvPrefix}* environment variables are set for provider "groq".`);
  }
  if (!form.get("model")) form.set("model", TRANSCRIBE_MODEL);
  const model = String(form.get("model"));

  let cursor = cursors.get("groq") ?? 0;
  let lastError: unknown;
  let limited = 0;
  let retryAfter: string | undefined;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const { key } = keys[cursor % keys.length];
    cursor++;

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (res.status === 429) {
      limited++;
      const wait = res.headers.get("retry-after");
      if (wait && (retryAfter === undefined || Number(wait) < Number(retryAfter))) retryAfter = wait;
      lastError = new Error("groq key hit its rate limit (429)");
      continue;
    }

    recordUsage("groq", key, model, 0);
    cursors.set("groq", cursor);
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get("content-type") ?? "application/json",
    };
  }

  cursors.set("groq", cursor);
  if (limited === keys.length) {
    return {
      status: 429,
      body: JSON.stringify({ error: "Every groq key hit its rate limit (429)." }),
      contentType: "application/json",
      retryAfter,
    };
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All groq API keys are unavailable right now.");
}
