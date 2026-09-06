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

const MAX_KEYS_PER_PROVIDER = 21;

// One rotation cursor per provider, so calling Cerebras doesn't perturb
// SEA-LION's rotation and vice versa. Best-effort — lives per warm instance.
const cursors = new Map<ProviderId, number>();

// Per-key daily token usage (Groq only). Keyed by "<providerId>:<key>", reset
// whenever the tracked UTC day no longer matches today. Same caveat as the
// rotation cursor: in-memory per warm instance, not synced across concurrent
// serverless instances or cold starts — a best-effort spread, not an exact
// quota ledger.
type UsageEntry = { day: string; tokens: number };
const dailyUsage = new Map<string, UsageEntry>();

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function getUsedTokens(providerId: ProviderId, key: string): number {
  const entry = dailyUsage.get(`${providerId}:${key}`);
  return entry && entry.day === todayUTC() ? entry.tokens : 0;
}

function addUsedTokens(providerId: ProviderId, key: string, tokens: number): void {
  const mapKey = `${providerId}:${key}`;
  const day = todayUTC();
  const entry = dailyUsage.get(mapKey);
  if (entry && entry.day === day) {
    entry.tokens += tokens;
  } else {
    dailyUsage.set(mapKey, { day, tokens });
  }
}

function collectKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= MAX_KEYS_PER_PROVIDER; i++) {
    const key = process.env[`${prefix}${i}`];
    if (key) keys.push(key);
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

  let cursor = cursors.get(providerId) ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[cursor % keys.length];
    cursor++;

    if (
      config.dailyTokenLimitPerKey &&
      getUsedTokens(providerId, key) >= config.dailyTokenLimitPerKey
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

    if (config.dailyTokenLimitPerKey) {
      const totalTokens = (data as { usage?: { total_tokens?: number } })?.usage
        ?.total_tokens;
      if (typeof totalTokens === "number") {
        addUsedTokens(providerId, key, totalTokens);
      }
    }

    cursors.set(providerId, cursor);
    return { status: res.status, data };
  }

  cursors.set(providerId, cursor);
  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${providerId} API keys are unavailable right now.`);
}
