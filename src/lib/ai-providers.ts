export type ProviderId = "sea-lion" | "cerebras" | "groq";

type ProviderConfig = {
  baseUrl: string;
  keyEnvPrefix: string;
  defaultModel: string;
};

// Both providers speak the OpenAI chat-completions format, so one call path
// covers both. Free/preview tiers on both cap requests per minute per key,
// so we round-robin every call across all `<PREFIX>1..21` keys found for the
// chosen provider, and fall through to the next key on a 429 before giving up.
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

function collectKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= MAX_KEYS_PER_PROVIDER; i++) {
    const key = process.env[`${prefix}${i}`];
    if (key) keys.push(key);
  }
  return keys;
}

export async function callProvider(
  providerId: ProviderId,
  body: Record<string, unknown>
): Promise<Response> {
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

    cursors.set(providerId, cursor);
    return res;
  }

  cursors.set(providerId, cursor);
  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${providerId} API keys are rate-limited. Try again shortly.`);
}
