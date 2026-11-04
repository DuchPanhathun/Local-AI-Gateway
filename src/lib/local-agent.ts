// Client for local-agent-gateway (https://github.com/.../local-agent), a separate
// Python service that runs on this same machine and forwards prompts to AI coding
// CLIs (Claude Code, Codex, Gemini, Antigravity) installed here. Unlike the cloud
// providers in ai-providers.ts, these run as real subprocesses with filesystem
// access to an allowlisted workdir — that's local-agent-gateway's job to enforce,
// not ours. We just proxy.
//
// The `chatgpt`, `grok` and `mimo` providers are chatgpt-web-gateway
// (../chatgpt-web) instead, another local service: it answers through
// chatgpt.com, grok.com and Xiaomi MiMo Studio in its own signed-in Chrome
// window. It speaks the same API, so it's called the same way at its own address.

import { Agent, fetch as undiciFetch } from "undici";
import { getDayUsage, recordUsageEvent, todayUTC } from "./usage-ledger";

export type LocalAgentProviderId =
  | "claude"
  | "codex"
  | "gemini"
  | "antigravity"
  | "chatgpt"
  | "grok"
  | "mimo";

export const LOCAL_AGENT_PROVIDER_IDS: LocalAgentProviderId[] = [
  "claude",
  "codex",
  "gemini",
  "antigravity",
  "chatgpt",
  "grok",
  "mimo",
];

export function isLocalAgentProviderId(value: string): value is LocalAgentProviderId {
  return (LOCAL_AGENT_PROVIDER_IDS as string[]).includes(value);
}

// The CLIs take one prompt string, not a conversation: they keep their own
// history (resumed by session_id). A caller that sends an OpenAI-style
// `messages` array instead gets its last user message sent.
export function lastUserMessage(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m?.role === "user" && typeof m.content === "string" && m.content) return m.content;
  }
  return null;
}

type Gateway = {
  name: string;
  url: string;
  tokenVar: string;
  providers: LocalAgentProviderId[];
};

function localAgentGateway(): Gateway {
  return {
    name: "local-agent-gateway",
    url: process.env.LOCAL_AGENT_URL || "http://127.0.0.1:8787",
    tokenVar: "LOCAL_AGENT_TOKEN",
    providers: ["claude", "codex", "gemini", "antigravity"],
  };
}

function chatgptWebGateway(): Gateway {
  return {
    name: "chatgpt-web-gateway",
    url: process.env.CHATGPT_WEB_URL || "http://127.0.0.1:8789",
    tokenVar: "CHATGPT_WEB_TOKEN",
    providers: ["chatgpt", "grok", "mimo"],
  };
}

export function isWebChat(provider: LocalAgentProviderId): boolean {
  return chatgptWebGateway().providers.includes(provider);
}

function gatewayFor(provider: LocalAgentProviderId): Gateway {
  return isWebChat(provider) ? chatgptWebGateway() : localAgentGateway();
}

// "local-agent-gateway at http://127.0.0.1:8787": which gateway serves a provider, and where.
export function gatewayAddress(provider: LocalAgentProviderId): string {
  const gateway = gatewayFor(provider);
  return `${gateway.name} at ${gateway.url}`;
}

function authHeaders(gateway: Gateway, extra?: Record<string, string>): Record<string, string> {
  const token = process.env[gateway.tokenVar];
  if (!token) {
    throw new Error(`${gateway.tokenVar} is not set — ${gateway.providers.join(", ")} unavailable.`);
  }
  return { Authorization: `Bearer ${token}`, ...extra };
}

export type AskRequest = {
  provider: LocalAgentProviderId;
  prompt: string;
  model?: string;
  session_id?: string;
  workdir?: string; // CLIs only
  no_tools?: boolean; // CLIs only
  temporary?: boolean; // web chats only: false saves the chat so session_id can continue it (mimo always saves)
};

export type GatewayCallResult = { status: number; data: unknown };

// Each gateway gets only the fields it understands (both refuse unknown ones).
function askBody(req: AskRequest): string {
  const { workdir, no_tools, temporary, ...common } = req;
  return JSON.stringify(
    isWebChat(req.provider)
      ? { ...common, ...(temporary !== undefined ? { temporary } : {}) }
      : { ...common, ...(workdir ? { workdir } : {}), ...(no_tools !== undefined ? { no_tools } : {}) }
  );
}

// A run can think for minutes without sending a byte (Gemini High: 309 seconds of
// silence, then the whole answer). Node's fetch gives up on a response that stays
// quiet for 5 minutes (headersTimeout and bodyTimeout) and reports it as just
// "terminated", which cut every long run off. The gateway has its own clock
// (REQUEST_TIMEOUT_S), so these calls get no second one. The package is pinned to
// the undici version built into Node, so the two cannot disagree.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export async function ask(req: AskRequest, signal?: AbortSignal): Promise<GatewayCallResult> {
  const gateway = gatewayFor(req.provider);
  const res = await undiciFetch(`${gateway.url}/ask`, {
    method: "POST",
    headers: authHeaders(gateway, { "Content-Type": "application/json" }),
    body: askBody(req),
    signal,
    dispatcher: patient,
  });
  return { status: res.status, data: await res.json() };
}

// Returns the raw upstream Response so its SSE body can be piped straight
// through to our own caller without buffering. Pass the incoming request's
// signal: aborting closes the connection to the gateway, which then kills the
// CLI's process tree (or presses Stop on ChatGPT) instead of letting it run to
// completion unread.
export async function askStream(req: AskRequest, signal?: AbortSignal): Promise<Response> {
  const gateway = gatewayFor(req.provider);
  const res = await undiciFetch(`${gateway.url}/ask/stream`, {
    method: "POST",
    headers: authHeaders(gateway, { "Content-Type": "application/json" }),
    body: askBody(req),
    signal,
    dispatcher: patient,
  });
  return res as unknown as Response; // same API; undici's own type for it differs only in name
}

export type ImageRequest = {
  provider?: "codex";
  prompt: string;
  model?: string;
  images?: { data_base64: string; label?: string }[];
  workdir?: string;
};

export async function image(req: ImageRequest): Promise<GatewayCallResult> {
  const gateway = localAgentGateway();
  const res = await fetch(`${gateway.url}/image`, {
    method: "POST",
    headers: authHeaders(gateway, { "Content-Type": "application/json" }),
    body: JSON.stringify(req),
  });
  return { status: res.status, data: await res.json() };
}

// Text to speech and speech to text on the websites' speech pages (MiMo
// Studio's TTS and ASR models), through chatgpt-web-gateway.
export type SpeechRequest = {
  provider?: "mimo";
  model?: string; // mimo-v2.5-tts (default), -tts-voicedesign, -tts-voiceclone
  input: string;
  voice?: string; // tts: one of GET /voices
  instructions?: string; // tts: the style; voicedesign: the voice, described
  reference_audio_base64?: string; // voiceclone: the voice to copy
  voice_consent?: boolean; // voiceclone: ticks MiMo's voiceprint-upload consent for this request
};

export type WebTranscriptionRequest = {
  provider?: "mimo";
  model?: string; // mimo-v2.5-asr
  audio_base64: string;
  filename?: string;
};

async function postTo(gateway: Gateway, path: string, body: unknown): Promise<GatewayCallResult> {
  const res = await fetch(`${gateway.url}${path}`, {
    method: "POST",
    headers: authHeaders(gateway, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// Answers { audio_base64, mime_type, voice, ... } (MiMo: WAV).
export async function speech(req: SpeechRequest): Promise<GatewayCallResult> {
  return postTo(chatgptWebGateway(), "/speech", req);
}

// Answers { text, ... }.
export async function transcribeOnWeb(req: WebTranscriptionRequest): Promise<GatewayCallResult> {
  return postTo(chatgptWebGateway(), "/transcribe", req);
}

// The speech and transcription models, and the voices, per site.
export async function voices(): Promise<GatewayCallResult> {
  return getFrom(chatgptWebGateway(), "/voices");
}

async function getFrom(gateway: Gateway, path: string): Promise<GatewayCallResult> {
  try {
    const res = await fetch(`${gateway.url}${path}`, { headers: authHeaders(gateway) });
    return { status: res.status, data: await res.json() };
  } catch (err) {
    const why = err instanceof Error ? err.message : "unreachable";
    return { status: 502, data: { error: `${gateway.name}: ${why}` } };
  }
}

// GET `path` from both gateways and merge their `providers` maps, so callers
// see one list. A gateway that is down only takes its own providers with it:
// they're listed as not installed, with the reason in `error`. Only when both
// are down is the answer an error, local-agent-gateway's.
async function fromBoth(path: string): Promise<GatewayCallResult> {
  const gateways = [localAgentGateway(), chatgptWebGateway()];
  const results = await Promise.all(gateways.map((g) => getFrom(g, path)));
  if (results.every((r) => r.status !== 200)) return results[0];
  const providers: Record<string, unknown> = {};
  results.forEach((result, i) => {
    const gateway = gateways[i];
    const data = result.data as { providers?: Record<string, unknown>; error?: string; detail?: string };
    const reason =
      result.status === 200
        ? null
        : data.error ?? data.detail ?? `${gateway.name} returned HTTP ${result.status}`;
    for (const id of gateway.providers) {
      providers[id] = (result.status === 200 && data.providers?.[id]) || {
        // Covers every shape callers read: health, models and limits.
        installed: false,
        path: null,
        version: null,
        default: null,
        models: [],
        note: null,
        supported: false,
        limits: [],
        checked_at: null,
        error: reason ?? `${gateway.name} didn't list ${id}`,
      };
    }
  });
  const base = results[0].status === 200 ? (results[0].data as object) : {};
  return { status: 200, data: { ...base, providers } };
}

export async function health(): Promise<GatewayCallResult> {
  return fromBoth("/health");
}

// Whether each CLI is signed in, as local-agent-gateway asks the CLIs themselves
// (its GET /auth). A gateway without that endpoint answers 404: no sign-in news.
export async function auth(): Promise<GatewayCallResult> {
  return getFrom(localAgentGateway(), "/auth");
}

export async function models(): Promise<GatewayCallResult> {
  return fromBoth("/models");
}

// How much of each CLI's subscription limits is left and when they reset,
// from the CLIs that can say (Claude Code, Antigravity). Checking uses none
// of it.
export async function limits(): Promise<GatewayCallResult> {
  return fromBoth("/limits");
}

// Tokens one run used, as local-agent-gateway reports them. Only Claude Code
// and Antigravity report usage; Codex and Gemini runs come back with null.
export type GatewayUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

// The names cloud providers use, so callers read tokens one way.
export function toOpenAIUsage(usage: GatewayUsage | null | undefined) {
  if (!usage) return null;
  const prompt = usage.input_tokens ?? 0;
  const completion = usage.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens ?? prompt + completion,
  };
}

// Normalizes local-agent-gateway's {result, model, session_id, duration_ms,
// usage} shape into the same OpenAI-ish {choices[0].message.content} shape
// every other provider in this app returns, so callers parse one way
// regardless of which provider answered.
export function normalizeAskResponse(data: unknown): unknown {
  const d = data as {
    provider?: string;
    model?: string | null;
    result?: string;
    session_id?: string;
    duration_ms?: number;
    usage?: GatewayUsage | null;
  };
  return {
    id: `local-${d.session_id ?? "noid"}`,
    object: "chat.completion",
    provider: d.provider,
    model: d.model,
    session_id: d.session_id,
    duration_ms: d.duration_ms,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: d.result ?? "" },
      },
    ],
    usage: toOpenAIUsage(d.usage),
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// Runs are counted in the usage ledger (usage-ledger.ts) per provider and
// model, the same as cloud calls, minus the per-key breakdown: there are no
// keys to rotate here.
export type LocalRunOutcome = {
  // "stopped": the caller hung up mid-run. It still counts as a request,
  // but not as an error.
  status: "ok" | "error" | "stopped";
  model?: string | null; // the model that answered, when the gateway says
  usage?: GatewayUsage | null;
  durationMs?: number;
  answerChars?: number; // the answer's length, when there was one
};

// Who made the run, when it was an access token: the key's id, and the
// prompt's length (for estimating its tokens, which the web chats and some
// CLIs don't report).
export type RunCaller = { id?: string; promptChars?: number };

// A run whose model the gateway never named (it failed or was stopped before
// the CLI said) is filed under the model asked for, else "default".
export function recordLocalRun(
  provider: LocalAgentProviderId,
  requestedModel: string | undefined,
  outcome: LocalRunOutcome,
  caller?: RunCaller
): void {
  recordUsageEvent(provider, outcome.model || requestedModel || "default", {
    status: outcome.status,
    usage: toOpenAIUsage(outcome.usage),
    durationMs: outcome.durationMs,
    caller: caller?.id,
    textChars: (caller?.promptChars ?? 0) + (outcome.answerChars ?? 0),
  });
}

export type LocalUsageSnapshot = {
  provider: LocalAgentProviderId;
  model: string;
  requestsToday: number;
  errorsToday: number;
  promptTokensToday: number;
  completionTokensToday: number;
  tokensToday: number;
  // False when no run today reported tokens (Codex, Gemini): the zeros above
  // then mean "unknown", not "none".
  tokensReported: boolean;
  avgDurationMs: number | null; // over finished runs
  finishedToday: number;
  lastUsedAt: string;
};

// Only providers and models used today: unlike cloud keys, there's no
// inventory to show at zero.
export function getLocalUsageSnapshot(): LocalUsageSnapshot[] {
  return getDayUsage(todayUTC())
    .filter((m) => isLocalAgentProviderId(m.provider))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
    .map((m) => ({
      provider: m.provider as LocalAgentProviderId,
      model: m.model,
      requestsToday: m.requests,
      errorsToday: m.errors,
      promptTokensToday: m.promptTokens,
      completionTokensToday: m.completionTokens,
      tokensToday: m.totalTokens,
      tokensReported: m.tokensReported,
      avgDurationMs: m.avgDurationMs,
      finishedToday: m.timed,
      lastUsedAt: m.lastUsedAt ?? "",
    }));
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

// Passes local-agent-gateway's Server-Sent Events through to our caller as
// they arrive, with one change: `done.usage` gets the cloud providers' names
// (prompt_tokens, completion_tokens, total_tokens), so every provider's
// stream reads the same. Calls `onFinish` once with how the run ended — done,
// error, or the caller hanging up first (`signal` is the caller's request's).
export function relayStream(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFinish: (outcome: LocalRunOutcome) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let outcome: LocalRunOutcome | null = null;
  let reported = false;
  const report = (fallback: LocalRunOutcome) => {
    if (reported) return;
    reported = true;
    onFinish(outcome ?? fallback);
  };

  // One whole event, without the blank line that ends it.
  const relay = (block: string): string => {
    const lines = block.split("\n");
    const name = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if ((name !== "done" && name !== "error") || !dataLine) return block;
    if (name === "error") {
      outcome = { status: "error" };
      return block;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataLine.slice(5));
    } catch {
      outcome = { status: "ok" };
      return block;
    }
    const usage = data.usage as GatewayUsage | null | undefined;
    outcome = {
      status: "ok",
      model: typeof data.model === "string" ? data.model : null,
      usage,
      durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
      answerChars: typeof data.result === "string" ? data.result.length : undefined,
    };
    return `event: done\ndata: ${JSON.stringify({ ...data, usage: toOpenAIUsage(usage) })}`;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Once the caller has gone, enqueue/close throw; nobody is left to tell.
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {}
      };
      const close = () => {
        try {
          controller.close();
        } catch {}
      };
      const fail = (detail: string) =>
        send(`event: error\ndata: ${JSON.stringify({ status: 502, detail })}\n\n`);

      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          if (blocks.length) send(blocks.map((b) => `${relay(b)}\n\n`).join(""));
        }
        if (buffer.trim()) send(`${relay(buffer)}\n\n`);
        if (!outcome && !signal.aborted) {
          fail("local-agent-gateway's stream ended before the run finished");
        }
      } catch (err) {
        if (!signal.aborted) {
          fail(err instanceof Error ? err.message : "local-agent-gateway stream failed");
        }
      } finally {
        report({ status: signal.aborted ? "stopped" : "error" });
        close();
      }
    },
    cancel() {
      // Caller went away (closed the tab, hit Stop): close the gateway
      // connection, which kills the CLI's process tree.
      report({ status: "stopped" });
      void reader.cancel();
    },
  });
}
