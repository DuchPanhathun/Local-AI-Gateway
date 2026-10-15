import {
  getKeyDayTokens,
  getKeyDayUsage,
  recordUsageEvent,
  todayUTC,
  type TokenUsage,
  type UsageOutcome,
} from "./usage-ledger";

export type ProviderId = "sea-lion" | "cerebras" | "groq";

type ProviderConfig = {
  baseUrl: string;
  keyEnvPrefix: string;
  defaultModel: string;
  // When set, a key stops being used once its tracked usage for the current
  // UTC day reaches this many tokens, and rotation moves on to the next key.
  dailyTokenLimitPerKey?: number;
  // Accepts stream_options.include_usage on streamed requests. Only set where
  // verified live — an unknown field can make a provider reject the request.
  streamUsage?: boolean;
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
    streamUsage: true,
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
    streamUsage: true,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

export function defaultModel(providerId: ProviderId): string {
  return PROVIDERS[providerId].defaultModel;
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

// Usage is counted per key and model (Cerebras quotas differ per model;
// SEA-LION/Groq just get one model row in practice). Daily totals go to the
// usage ledger, which survives restarts, so Groq's daily cap holds across
// them. Only the last 60 seconds — for the per-minute columns — are kept
// here, in memory, keyed by "<providerId>:<keyName>:<model>".
const recent = new Map<string, { ts: number; tokens: number }[]>();

function recentKey(providerId: ProviderId, keyName: string, model: string): string {
  return `${providerId}:${keyName}:${model}`;
}

// `keyName` is the env var holding the key (e.g. "GROQ_API_KEY3"), never the key.
function recordUsage(
  providerId: ProviderId,
  keyName: string,
  model: string,
  outcome: UsageOutcome
): void {
  const now = Date.now();
  const u = outcome.usage;
  const tokens = u?.total_tokens ?? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0);
  const mapKey = recentKey(providerId, keyName, model);
  // Prune anything older than 60s, and cap the list so memory can't grow
  // unbounded under sustained traffic.
  const list = (recent.get(mapKey) ?? []).filter((e) => e.ts >= now - 60_000);
  list.push({ ts: now, tokens });
  recent.set(mapKey, list.slice(-500));

  recordUsageEvent(providerId, model, { ...outcome, keyName });
}

function getDayTokens(providerId: ProviderId, keyName: string, model: string): number {
  return getKeyDayTokens(providerId, model, keyName, todayUTC());
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
  const startedAt = Date.now();
  let cursor = cursors.get(providerId) ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const { name, key } = keys[cursor % keys.length];
    cursor++;

    if (
      config.dailyTokenLimitPerKey &&
      getDayTokens(providerId, name, model) >= config.dailyTokenLimitPerKey
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

    recordUsage(providerId, name, model, {
      status: res.ok ? "ok" : "error",
      usage: (data as { usage?: TokenUsage } | null)?.usage ?? null,
      durationMs: Date.now() - startedAt,
    });

    cursors.set(providerId, cursor);
    return { status: res.status, data };
  }

  cursors.set(providerId, cursor);
  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${providerId} API keys are unavailable right now.`);
}

// ---------------------------------------------------------------------------
// Model lists
// ---------------------------------------------------------------------------

export type ModelInfo = { id: string; name: string };
export type ModelList = { default: string; models: ModelInfo[]; error: string | null };

const MODEL_LIST_TTL_MS = 10 * 60_000;
const modelListCache = new Map<ProviderId, { at: number; list: ModelList }>();

// Not chat models: embeddings, rerankers, and small safety classifiers
// (SEA-Guard, Llama Prompt Guard). gpt-oss-safeguard is a full reasoning
// LLM, so "safeguard" is deliberately not matched.
const NON_CHAT_MODEL = /embed|rerank|bge-|sea-guard|prompt-guard/i;

type UpstreamModel = {
  id: string;
  name?: string;
  active?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
};

// Groq reports modalities (filters out Whisper and text-to-speech); SEA-LION
// and Cerebras don't, so the name check is what catches their non-chat models.
function isChatModel(m: UpstreamModel): boolean {
  if (m.active === false) return false;
  if (m.input_modalities && !m.input_modalities.includes("text")) return false;
  if (m.output_modalities && !m.output_modalities.includes("text")) return false;
  return !NON_CHAT_MODEL.test(m.id);
}

// Live list from the provider's own /models, cached for 10 minutes. On
// failure, falls back to just the configured default so it stays selectable.
export async function listModels(providerId: ProviderId): Promise<ModelList> {
  const cached = modelListCache.get(providerId);
  if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.list;

  const config = PROVIDERS[providerId];
  const keys = collectKeys(config.keyEnvPrefix);
  let error: string | null = keys.length ? null : `No ${config.keyEnvPrefix}* keys are set`;

  for (const { key } of keys.slice(0, 3)) {
    try {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        error = `${providerId} /models returned HTTP ${res.status}`;
        continue;
      }
      const data = (await res.json()) as { data?: UpstreamModel[] };
      const models = (data.data ?? [])
        .filter(isChatModel)
        .map((m) => ({ id: m.id, name: m.name ?? m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!models.some((m) => m.id === config.defaultModel)) {
        models.unshift({ id: config.defaultModel, name: config.defaultModel });
      }
      const list = { default: config.defaultModel, models, error: null };
      modelListCache.set(providerId, { at: Date.now(), list });
      return list;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    default: config.defaultModel,
    models: [{ id: config.defaultModel, name: config.defaultModel }],
    error,
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; status: number; error: string };

// Providers return errors in different shapes: {error: {message}} (Groq,
// SEA-LION), {error: "..."}, or {message} (Cerebras).
function upstreamErrorMessage(data: unknown, status: number): string {
  const d = data as { error?: unknown; message?: unknown; detail?: unknown } | null;
  const e = d?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  if (typeof d?.message === "string") return d.message;
  if (typeof d?.detail === "string") return d.detail;
  return `Upstream request failed (HTTP ${status})`;
}

type StreamChunk = {
  model?: string;
  error?: unknown;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
};

// Converts an OpenAI-style chat.completion.chunk stream into the same SSE
// events local-agent-gateway emits (start / delta / done / error), plus a
// `thinking` event for reasoning text, so the Playground parses one format.
// SEA-LION streams reasoning as delta.reasoning_content, Groq as
// delta.reasoning; Groq also reports usage under x_groq.usage.
function toEventStream(
  providerId: ProviderId,
  keyName: string,
  model: string,
  upstream: ReadableStream<Uint8Array>,
  // When the request was sent, not when headers came back — otherwise queue
  // and prompt-processing time vanish from the reported latency.
  startedAt: number,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  const event = (name: string, data: unknown) =>
    encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  let result = "";
  let reportedModel: string | undefined;
  let finishReason: string | null = null;
  let usage: TokenUsage | undefined;
  let finished = false;
  let upstreamError = false;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Once the caller has gone, the controller is closed and enqueue/close
      // throw; there's nobody left to tell, so those are ignored.
      const send = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {}
      };
      const close = () => {
        try {
          controller.close();
        } catch {}
      };
      send(event("start", { provider: providerId }));
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, "");
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") {
              finished = true;
              continue;
            }
            let chunk: StreamChunk;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue;
            }
            if (chunk.error) {
              upstreamError = true;
              send(
                event("error", { status: 502, detail: upstreamErrorMessage(chunk, 502) })
              );
              close();
              return;
            }
            if (chunk.model) reportedModel = chunk.model;
            const choice = chunk.choices?.[0];
            const thinking = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
            if (thinking) send(event("thinking", { text: thinking }));
            const text = choice?.delta?.content;
            if (text) {
              result += text;
              send(event("delta", { text }));
            }
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
              finished = true;
            }
            const u = chunk.usage ?? chunk.x_groq?.usage;
            if (u) usage = u;
          }
        }

        if (!finished) {
          send(
            event("error", { status: 502, detail: `${providerId} stream ended before completion` })
          );
        } else {
          send(
            event("done", {
              provider: providerId,
              model: reportedModel ?? model,
              result: result.trim(),
              finish_reason: finishReason,
              usage: usage
                ? {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                  }
                : null,
              duration_ms: Date.now() - startedAt,
            })
          );
        }
        close();
      } catch (err) {
        send(
          event("error", {
            status: 502,
            detail: err instanceof Error ? err.message : `${providerId} stream failed`,
          })
        );
        close();
      } finally {
        // An answer that got its finish_reason counts as done even if the
        // caller hangs up before the stream closes. A caller hanging up
        // earlier (Stop, closed tab) shows up above as an aborted read or an
        // early end — that's "stopped", not a failure.
        const stopped = cancelled || !!signal?.aborted;
        recordUsage(providerId, keyName, model, {
          status: finished && !upstreamError ? "ok" : stopped ? "stopped" : "error",
          usage: usage ?? null,
          durationMs: Date.now() - startedAt,
        });
      }
    },
    cancel() {
      // Caller went away (closed the tab, hit stop) — stop paying for tokens.
      cancelled = true;
      void reader.cancel();
    },
  });
}

// Like callProvider, but streams. Key rotation (daily limit skip, 429 and
// network-error fallthrough) happens before the stream opens; once a key
// answers with a stream, that key is committed for the whole response.
//
// `signal` should be the incoming request's: when the caller disconnects
// (closed tab, Stop button) it aborts the upstream request too. Without it the
// provider keeps generating the whole answer into a connection nobody reads,
// because the framework doesn't reliably cancel a streamed response body.
export async function streamProvider(
  providerId: ProviderId,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<StreamResult> {
  const config = PROVIDERS[providerId];
  const keys = collectKeys(config.keyEnvPrefix);
  if (keys.length === 0) {
    throw new Error(
      `No ${config.keyEnvPrefix}* environment variables are set for provider "${providerId}".`
    );
  }

  const model = (body.model as string | undefined) || config.defaultModel;
  const startedAt = Date.now();
  let cursor = cursors.get(providerId) ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const { name, key } = keys[cursor % keys.length];
    cursor++;

    if (
      config.dailyTokenLimitPerKey &&
      getDayTokens(providerId, name, model) >= config.dailyTokenLimitPerKey
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
        body: JSON.stringify({
          model: config.defaultModel,
          ...body,
          stream: true,
          ...(config.streamUsage ? { stream_options: { include_usage: true } } : {}),
        }),
        signal,
      });
    } catch (err) {
      // The caller left; don't burn the next key's quota on nobody.
      if (signal?.aborted) throw err;
      lastError = err;
      continue;
    }

    if (res.status === 429) {
      void res.body?.cancel();
      lastError = new Error(`${providerId} key hit its rate limit (429)`);
      continue;
    }

    cursors.set(providerId, cursor);
    if (!res.ok || !res.body) {
      // Counted like callProvider counts it: a rejected request still used
      // one of the key's requests-per-minute.
      recordUsage(providerId, name, model, { status: "error" });
      const data = await res.json().catch(() => null);
      return { ok: false, status: res.status, error: upstreamErrorMessage(data, res.status) };
    }
    return {
      ok: true,
      stream: toEventStream(providerId, name, model, res.body, startedAt, signal),
    };
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
  const cutoff = Date.now() - 60_000;
  const day = todayUTC();
  const snapshot: KeyUsageSnapshot[] = [];

  for (const providerId of PROVIDER_IDS) {
    const config = PROVIDERS[providerId];
    const today = getKeyDayUsage(providerId, day);

    for (const { name } of collectKeys(config.keyEnvPrefix)) {
      // Every model this key was used with today or in the last minute,
      // defaulting to just the provider's default model when it hasn't been.
      const modelsUsed = new Set<string>(today.get(name)?.keys() ?? []);
      const prefix = `${providerId}:${name}:`;
      for (const mapKey of recent.keys()) {
        if (mapKey.startsWith(prefix)) modelsUsed.add(mapKey.slice(prefix.length));
      }
      if (modelsUsed.size === 0) modelsUsed.add(config.defaultModel);

      for (const model of modelsUsed) {
        const lastMinute = (recent.get(recentKey(providerId, name, model)) ?? []).filter(
          (e) => e.ts >= cutoff
        );
        const daily = today.get(name)?.get(model);

        snapshot.push({
          provider: providerId,
          keyName: name,
          model,
          requestsLast60s: lastMinute.length,
          tokensLast60s: lastMinute.reduce((sum, e) => sum + e.tokens, 0),
          requestsToday: daily?.requests ?? 0,
          tokensToday: daily?.tokens ?? 0,
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
  const startedAt = Date.now();

  let cursor = cursors.get("groq") ?? 0;
  let lastError: unknown;
  let limited = 0;
  let retryAfter: string | undefined;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const { name, key } = keys[cursor % keys.length];
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

    // Whisper answers carry no token counts; it's counted in requests.
    recordUsage("groq", name, model, {
      status: res.ok ? "ok" : "error",
      durationMs: Date.now() - startedAt,
    });
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
