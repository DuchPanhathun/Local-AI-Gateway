import {
  audioMimeType,
  classifyGoogleFailure,
  cooldowns,
  GOOGLE_DEFAULT_CHAT_MODEL,
  GOOGLE_LIMITS,
  googleChatModels,
  googleModelId,
  interactions,
  isFinal,
  nativeUsage,
  signatures,
  speechBody,
  transcriptFrom,
  unwrapGoogleError,
  wavFromAnswer,
  withThoughts,
  type GoogleResponse,
} from "./google-ai";
import { KeyLimits, retryAfterSeconds } from "./rate-limits";
import {
  getKeyDayTokens,
  getKeyDayUsage,
  recordUsageEvent,
  todayUTC,
  type TokenUsage,
  type UsageOutcome,
} from "./usage-ledger";

export type ProviderId = "sea-lion" | "cerebras" | "groq" | "coarena" | "google";

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
  // The output allowance to ask for when a caller names none (max_tokens or
  // max_completion_tokens). For a provider whose own default is below what its
  // models can do and counts reasoning against it: Coarena's is 8,192, and a
  // model thinking over a long context can spend all of it and end with no
  // answer (finish_reason "length").
  defaultMaxTokens?: number;
  // Google AI Studio: limits are per model and a 429 says which one ran out, so a key that has refused a model is
  // held off it (see google-ai.ts). Its errors come wrapped in arrays and its tool calls carry thought signatures.
  quota?: "google";
  // A request that takes longer than this is given up on, without trying the next key (it would hang too).
  timeoutMs?: number;
  // The same for a stream, until its first bytes: Gemini 3.8 Flash has been seen taking minutes to say nothing.
  firstByteMs?: number;
};

// All five providers speak the OpenAI chat-completions format, so one call
// path covers them. Free/preview tiers cap requests per minute per key, so we
// round-robin every call across all `<PREFIX>1..50` keys found for the chosen
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
  // Coarena's Model API: one OpenAI-compatible endpoint in front of many models
  // (Claude, Gemini, Grok, Kimi, ...), so the model list below is whatever its
  // own /models says. Claude Fable 5.2 is the default. Fable decides per request
  // whether to think first; when it does, that arrives as delta.reasoning and
  // uses up max_tokens, so callers should leave room. stream_options.include_usage
  // verified live.
  coarena: {
    baseUrl: "https://coarena.ai/api/v1",
    keyEnvPrefix: "COARENA_API_KEY",
    defaultModel: process.env.COARENA_MODEL || "claude-fable-5-2",
    streamUsage: true,
    // Its own default is 8,192; 16,384 is the most it allows. Measured: runs on
    // Fable 5.2 and Opus 5.5 ended "length" with all 8,192 tokens spent on thinking.
    defaultMaxTokens: Number(process.env.COARENA_MAX_TOKENS) || 16_384,
  },
  // Google AI Studio's free tier, through its OpenAI-compatible endpoint. Keys are GOOGLE_AI_STUDIO_API_KEY1..N
  // (new ones start "AQ."). Embeddings go through the same endpoint; speech, transcription, Decision 1 and the
  // Antigravity agents have their own (callGoogleNative below). stream_options.include_usage verified live.
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnvPrefix: "GOOGLE_AI_STUDIO_API_KEY",
    defaultModel: process.env.GOOGLE_AI_STUDIO_MODEL || GOOGLE_DEFAULT_CHAT_MODEL,
    streamUsage: true,
    quota: "google",
    timeoutMs: Number(process.env.GOOGLE_AI_STUDIO_TIMEOUT_S) * 1000 || 120_000,
    firstByteMs: Number(process.env.GOOGLE_AI_STUDIO_FIRST_BYTE_S) * 1000 || 60_000,
  },
};

// The JSON body sent upstream: the provider's default model and output
// allowance, under whatever the caller sent.
function requestBody(config: ProviderConfig, body: Record<string, unknown>, model = config.defaultModel): Record<string, unknown> {
  const out: Record<string, unknown> = { model, ...body };
  if (config.defaultMaxTokens && out.max_tokens == null && out.max_completion_tokens == null) {
    out.max_tokens = config.defaultMaxTokens;
  }
  return out;
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

export function defaultModel(providerId: ProviderId): string {
  return PROVIDERS[providerId].defaultModel;
}

// Where the provider's API is, for saying what couldn't be reached.
export function providerHost(providerId: ProviderId): string {
  return new URL(PROVIDERS[providerId].baseUrl).host;
}

// How many API keys are set for a provider, and what to name the first one.
export function keySetup(providerId: ProviderId): { count: number; envName: string } {
  const { keyEnvPrefix } = PROVIDERS[providerId];
  return { count: collectKeys(keyEnvPrefix).length, envName: `${keyEnvPrefix}1` };
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
  // From the x-ratelimit-limit-requests header Coarena sends (30, resetting
  // every 60 s) on a free key; the same for every model.
  coarena: { "*": { requestsPerMin: 30 } },
  // AI Studio's free tier per project, per model (google-ai.ts). Keys from one project share them.
  google: GOOGLE_LIMITS,
};

function limitsFor(providerId: ProviderId, model: string): QuotaLimits | undefined {
  const table = KNOWN_LIMITS[providerId];
  if (!table) return undefined;
  return table[model] ?? table["*"];
}

// Numbers above this are ignored, silently: keep it above the most keys any provider has.
const MAX_KEYS_PER_PROVIDER = 50;

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
  outcome: UsageOutcome,
  silent = false
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

  // A test chat (see provider-check.ts) counts toward the key's rate limit above,
  // but not as traffic in the ledger: it's not a request anyone made.
  if (!silent) recordUsageEvent(providerId, model, { ...outcome, keyName });
}

// How much text is in an OpenAI-style message list, for estimating a caller's
// tokens when the provider doesn't report them.
function messageChars(messages: unknown): number {
  if (typeof messages === "string") return messages.length; // an embeddings `input`
  if (!Array.isArray(messages)) return 0;
  if (messages.every((m) => typeof m === "string")) return (messages as string[]).reduce((n, m) => n + m.length, 0);
  let chars = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown } | null)?.text;
        if (typeof text === "string") chars += text.length;
      }
    }
  }
  return chars;
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

// `caller`: the access token's id, when one made the request. `silent`: for a
// test chat, which isn't recorded as traffic. `path`/`model`: another endpoint
// of the same API (embeddings), and the model to use when the body names none.
export async function callProvider(
  providerId: ProviderId,
  body: Record<string, unknown>,
  caller?: string,
  { silent = false, path = "/chat/completions", model: fallbackModel }: { silent?: boolean; path?: string; model?: string } = {}
): Promise<ProviderCallResult> {
  const config = PROVIDERS[providerId];
  const keys = collectKeys(config.keyEnvPrefix);
  if (keys.length === 0) {
    throw new Error(
      `No ${config.keyEnvPrefix}* environment variables are set for provider "${providerId}".`
    );
  }

  const google = config.quota === "google";
  const model = (body.model as string | undefined) || fallbackModel || config.defaultModel;
  const startedAt = Date.now();
  let cursor = cursors.get(providerId) ?? 0;
  let lastError: unknown;
  const limits = new KeyLimits(providerId, keys.length);
  // Google: keys that can't give this model at all, and what Google said.
  let final: GoogleResponse | undefined;
  let finalKeys = 0;

  // Google's tool calls need their thought signatures back (google-ai.ts).
  const sent = requestBody(config, body, fallbackModel);
  const payload = JSON.stringify(google ? signatures.restore(sent) : sent);

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
      limits.pastDailyLimit();
      continue;
    }

    if (google) {
      const hold = cooldowns.hold(name, model);
      if (hold) {
        lastError = new Error(`${providerId} key can't be asked about ${model} for ${hold.wait} s (${hold.kind})`);
        limits.rateLimited(hold.wait);
        if (hold.response) {
        final = hold.response;
        finalKeys++;
      }
        continue;
      }
    }

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: payload,
        signal: config.timeoutMs ? AbortSignal.timeout(config.timeoutMs) : undefined,
      });
    } catch (err) {
      // A provider that hangs hangs for the next key too.
      if (config.timeoutMs && err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`${providerId} didn't answer ${model} within ${Math.round(config.timeoutMs / 1000)} s`);
      }
      lastError = err;
      continue;
    }

    let data: unknown;
    if (google) {
      data = unwrapGoogleError(await res.json().catch(() => null));
      const failure = classifyGoogleFailure(res.status, data);
      if (failure) {
        const response = { status: res.status, data };
        cooldowns.set(name, model, failure, response);
        lastError = new Error(`${providerId} key ${failure.kind} for ${model}`);
        limits.rateLimited(failure.wait);
        if (isFinal(failure.kind)) {
        final = response;
        finalKeys++;
      }
        continue;
      }
    } else {
      if (res.status === 429) {
        lastError = new Error(`${providerId} key hit its rate limit (429)`);
        limits.rateLimited(retryAfterSeconds(res.headers));
        continue;
      }
      data = await res.json();
    }
    if (google) {
      signatures.remember(data);
      const d = data as { usage?: Parameters<typeof withThoughts>[0] } | null;
      if (d && typeof d === "object" && d.usage) d.usage = withThoughts(d.usage);
    }

    const answer = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;

    recordUsage(providerId, name, model, {
      status: res.ok ? "ok" : "error",
      usage: (data as { usage?: TokenUsage } | null)?.usage ?? null,
      durationMs: Date.now() - startedAt,
      caller,
      textChars: messageChars(body.messages ?? body.input) + (typeof answer === "string" ? answer.length : 0),
    }, silent);

    cursors.set(providerId, cursor);
    return { status: res.status, data };
  }

  cursors.set(providerId, cursor);
  // Every key refused the model for good: Google's own answer, not "try later".
  if (final && finalKeys === keys.length) return final;
  // Every key over its limit: a RateLimitedError, which says when to retry.
  throw (
    limits.error() ??
    (lastError instanceof Error
      ? lastError
      : new Error(`All ${providerId} API keys are unavailable right now.`))
  );
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
  display_name?: string; // Coarena's, e.g. "Claude Fable 5.2"
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
  const google = config.quota === "google";

  for (const { key } of keys.slice(0, 3)) {
    try {
      const res = await fetch(`${config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        ...(config.timeoutMs ? { signal: AbortSignal.timeout(20_000) } : {}),
      });
      if (!res.ok) {
        error = `${providerId} /models returned HTTP ${res.status}`;
        continue;
      }
      const data = (await res.json()) as { data?: UpstreamModel[] };
      // Google lists 60-odd models, most of which a free key can't use or that aren't for chat (image, music, live
      // audio...): offer the text ones with a known free-tier limit that its list really has.
      const live = new Set((data.data ?? []).map((m) => googleModelId(m.id)));
      const models = google
        ? googleChatModels().filter((m) => live.has(m.id))
        : (data.data ?? [])
            .filter(isChatModel)
            .map((m) => ({ id: m.id, name: m.name ?? m.display_name ?? m.id }))
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

  // The list couldn't be fetched: Google's is known without it.
  if (google) return { default: config.defaultModel, models: googleChatModels(), error };
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
  const d = unwrapGoogleError(data) as { error?: unknown; message?: unknown; detail?: unknown } | null;
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
  signal?: AbortSignal,
  // The access token's id, when one made the request, and its prompt's length.
  caller?: { id: string; promptChars: number }
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

        if (providerId === "google") usage = withThoughts(usage);
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
          caller: caller?.id,
          textChars: (caller?.promptChars ?? 0) + result.length,
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
  signal?: AbortSignal,
  caller?: string
): Promise<StreamResult> {
  const config = PROVIDERS[providerId];
  const keys = collectKeys(config.keyEnvPrefix);
  if (keys.length === 0) {
    throw new Error(
      `No ${config.keyEnvPrefix}* environment variables are set for provider "${providerId}".`
    );
  }

  const google = config.quota === "google";
  const model = (body.model as string | undefined) || config.defaultModel;
  const startedAt = Date.now();
  let cursor = cursors.get(providerId) ?? 0;
  let lastError: unknown;
  const limits = new KeyLimits(providerId, keys.length);
  let final: GoogleResponse | undefined;
  let finalKeys = 0;

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
      limits.pastDailyLimit();
      continue;
    }

    if (google) {
      const hold = cooldowns.hold(name, model);
      if (hold) {
        lastError = new Error(`${providerId} key can't be asked about ${model} for ${hold.wait} s (${hold.kind})`);
        limits.rateLimited(hold.wait);
        if (hold.response) {
        final = hold.response;
        finalKeys++;
      }
        continue;
      }
    }

    // The caller's signal, plus a limit on how long the first bytes may take.
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    let timedOut = false;
    const timer = config.firstByteMs
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, config.firstByteMs)
      : undefined;

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          ...(google ? signatures.restore(requestBody(config, body)) : requestBody(config, body)),
          stream: true,
          ...(config.streamUsage ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // The caller left; don't burn the next key's quota on nobody.
      if (signal?.aborted) throw err;
      // A provider that says nothing for a minute says nothing to the next key too.
      if (timedOut) throw new Error(`${providerId} sent nothing for ${model} within ${Math.round((config.firstByteMs ?? 0) / 1000)} s`);
      lastError = err;
      continue;
    } finally {
      // Only the wait for the first bytes is limited. The caller's abort stays forwarded for as long as the
      // answer streams, so hanging up still stops the provider generating into nothing.
      clearTimeout(timer);
    }

    if (google && (res.status === 429 || res.status === 404)) {
      const data = unwrapGoogleError(await res.json().catch(() => null));
      const failure = classifyGoogleFailure(res.status, data);
      if (failure) {
        const response = { status: res.status, data };
        cooldowns.set(name, model, failure, response);
        lastError = new Error(`${providerId} key ${failure.kind} for ${model}`);
        limits.rateLimited(failure.wait);
        if (isFinal(failure.kind)) {
        final = response;
        finalKeys++;
      }
        continue;
      }
      // A 404 that is the caller's (no such model): answered as it is.
      cursors.set(providerId, cursor);
      recordUsage(providerId, name, model, { status: "error", caller });
      return { ok: false, status: res.status, error: upstreamErrorMessage(data, res.status) };
    }
    if (res.status === 429) {
      void res.body?.cancel();
      lastError = new Error(`${providerId} key hit its rate limit (429)`);
      limits.rateLimited(retryAfterSeconds(res.headers));
      continue;
    }

    cursors.set(providerId, cursor);
    if (!res.ok || !res.body) {
      // Counted like callProvider counts it: a rejected request still used
      // one of the key's requests-per-minute.
      recordUsage(providerId, name, model, { status: "error", caller });
      const data = await res.json().catch(() => null);
      return { ok: false, status: res.status, error: upstreamErrorMessage(data, res.status) };
    }
    return {
      ok: true,
      stream: toEventStream(
        providerId,
        name,
        model,
        res.body,
        startedAt,
        signal,
        caller ? { id: caller, promptChars: messageChars(body.messages) } : undefined
      ),
    };
  }

  cursors.set(providerId, cursor);
  if (final && finalKeys === keys.length) {
    return { ok: false, status: final.status, error: upstreamErrorMessage(final.data, final.status) };
  }
  // Every key over its limit: a RateLimitedError, which says when to retry.
  throw (
    limits.error() ??
    (lastError instanceof Error
      ? lastError
      : new Error(`All ${providerId} API keys are unavailable right now.`))
  );
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
export async function transcribeWithGroq(form: FormData, caller?: string): Promise<TranscriptionResult> {
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
      caller,
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

// ---------------------------------------------------------------------------
// Google's own endpoints
// ---------------------------------------------------------------------------

// Speech, transcription, Decision 1 and the Antigravity agents aren't on the OpenAI-compatible endpoint: they
// are Google's native API, over the same keys and the same rotation, cooldowns and usage counting.
const GOOGLE_NATIVE = PROVIDERS.google.baseUrl.replace(/\/openai\/?$/, "");

export type GoogleNativeRequest = {
  method?: "GET" | "POST" | "DELETE";
  // After /v1beta/: "models/gemini-3.8-flash-tts:generateContent", "decisions", "interactions/{id}".
  path: string;
  body?: unknown;
  // For the limits, the cooldowns and the usage count.
  model: string;
  caller?: string;
  // Only this key (an interaction's: it lives in the project of the key that made it).
  keyName?: string;
  // The size of the request's text, for the usage ledger.
  chars?: number;
  timeoutMs?: number;
  // false for a call that makes the model do nothing (reading, cancelling or deleting an interaction): it uses no
  // quota, and a read repeats the tokens its interaction already counted. Default true.
  count?: boolean;
};

// Calls one of Google's native endpoints with the next key that can take the model. `keyName` of the key that
// answered comes back so a caller can pin a follow-up to it.
export async function callGoogleNative(
  req: GoogleNativeRequest
): Promise<ProviderCallResult & { keyName: string }> {
  const config = PROVIDERS.google;
  const all = collectKeys(config.keyEnvPrefix);
  if (all.length === 0) {
    throw new Error(`No ${config.keyEnvPrefix}* environment variables are set for provider "google".`);
  }
  const keys = req.keyName ? all.filter((k) => k.name === req.keyName) : all;
  if (keys.length === 0) throw new Error(`The key that made this (${req.keyName}) isn't set any more.`);

  const model = googleModelId(req.model);
  const method = req.method ?? "POST";
  const timeoutMs = req.timeoutMs ?? config.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  let cursor = req.keyName ? 0 : (cursors.get("google") ?? 0);
  let lastError: unknown;
  const limits = new KeyLimits("google", keys.length);
  let final: GoogleResponse | undefined;
  let finalKeys = 0;
  // A call that makes the model do nothing is neither held back by the model's limits nor a reason to hold it.
  const metered = req.count !== false;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const { name, key } = keys[cursor % keys.length];
    cursor++;

    const hold = metered ? cooldowns.hold(name, model) : undefined;
    if (hold) {
      lastError = new Error(`google key can't be asked about ${model} for ${hold.wait} s (${hold.kind})`);
      limits.rateLimited(hold.wait);
      if (hold.response) {
        final = hold.response;
        finalKeys++;
      }
      continue;
    }

    let res: Response;
    try {
      res = await fetch(`${GOOGLE_NATIVE}/${req.path}`, {
        method,
        headers: { "x-goog-api-key": key, ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`google didn't answer ${model} within ${Math.round(timeoutMs / 1000)} s`);
      }
      lastError = err;
      continue;
    }

    const data = unwrapGoogleError(await res.json().catch(() => null));
    const failure = metered ? classifyGoogleFailure(res.status, data) : undefined;
    if (failure) {
      const response = { status: res.status, data };
      cooldowns.set(name, model, failure, response);
      lastError = new Error(`google key ${failure.kind} for ${model}`);
      limits.rateLimited(failure.wait);
      if (isFinal(failure.kind)) {
        final = response;
        finalKeys++;
      }
      continue;
    }

    if (metered) {
      recordUsage("google", name, model, {
        status: res.ok ? "ok" : "error",
        usage: nativeUsage(data),
        durationMs: Date.now() - startedAt,
        caller: req.caller,
        textChars: req.chars,
      });
    }
    if (!req.keyName) cursors.set("google", cursor);
    return { status: res.status, data, keyName: name };
  }

  if (!req.keyName) cursors.set("google", cursor);
  if (final && finalKeys === keys.length) return { ...final, keyName: keys[0].name };
  throw limits.error() ?? (lastError instanceof Error ? lastError : new Error("All google API keys are unavailable right now."));
}

export { interactions as googleInteractions };

// The names of the Google keys that are set, for a caller that has to ask them one by one.
export function googleKeyNames(): string[] {
  return collectKeys(PROVIDERS.google.keyEnvPrefix).map((k) => k.name);
}

export type GoogleSpeechResult = {
  status: number;
  model: string;
  voice: string;
  wav?: Uint8Array;
  durationMs?: number;
  // Google's answer, when there is no audio in it.
  data?: unknown;
};

// Text to speech with one of the Gemini TTS models. The audio comes back as a WAV file whichever format Google used.
export async function speakWithGoogle(
  request: { input: string; model: string; voice: string; instructions?: string },
  caller?: string
): Promise<GoogleSpeechResult> {
  const { status, data } = await callGoogleNative({
    path: `models/${googleModelId(request.model)}:generateContent`,
    body: speechBody(request.input, request.voice, request.instructions),
    model: request.model,
    caller,
    chars: request.input.length,
  });
  const base = { status, model: request.model, voice: request.voice };
  if (status < 200 || status >= 300) return { ...base, data };
  const audio = wavFromAnswer(data);
  return audio
    ? { ...base, wav: audio.bytes, durationMs: audio.durationMs }
    : { ...base, status: 502, data: { error: "The model answered without audio." } };
}

// Speech to text with Gemini 3.5 Transcribe, in the shape of the other transcription backends.
export async function transcribeWithGoogle(
  file: Blob,
  options: { model: string; prompt?: string; language?: string },
  caller?: string
): Promise<TranscriptionResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = audioMimeType(bytes, file.type, file instanceof File ? file.name : undefined);
  if (!mimeType) {
    const error = { error: { code: 400, status: "INVALID_ARGUMENT", message: "Can't tell what kind of audio this is. Send WAV, MP3, M4A/MP4, AAC, OGG, FLAC, AIFF or WebM." } };
    return { status: 400, body: JSON.stringify(error), contentType: "application/json" };
  }
  const audio = Buffer.from(bytes).toString("base64");
  // `prompt` is, as in OpenAI's form, words or spellings to expect: a hint inside the instruction, not the instruction.
  const instruction =
    `Transcribe this audio${options.language ? ` (spoken in ${options.language})` : ""}.` +
    (options.prompt ? ` It may contain these words or spellings: ${options.prompt}.` : "") +
    " Reply with the transcript only.";
  const { status, data } = await callGoogleNative({
    path: `models/${googleModelId(options.model)}:generateContent`,
    body: { contents: [{ parts: [{ inlineData: { mimeType, data: audio } }, { text: instruction }] }] },
    model: options.model,
    caller,
    timeoutMs: 150_000,
  });
  const ok = status >= 200 && status < 300;
  return {
    status,
    body: JSON.stringify(ok ? { text: transcriptFrom(data) } : data),
    contentType: "application/json",
  };
}
