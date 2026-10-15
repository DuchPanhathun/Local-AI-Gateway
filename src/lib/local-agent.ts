// Client for local-agent-gateway (https://github.com/.../local-agent), a separate
// Python service that runs on this same machine and forwards prompts to AI coding
// CLIs (Claude Code, Codex, Gemini, Antigravity) installed here. Unlike the cloud
// providers in ai-providers.ts, these run as real subprocesses with filesystem
// access to an allowlisted workdir — that's local-agent-gateway's job to enforce,
// not ours. We just proxy.

import { getDayUsage, recordUsageEvent, todayUTC } from "./usage-ledger";

export type LocalAgentProviderId = "claude" | "codex" | "gemini" | "antigravity";

export const LOCAL_AGENT_PROVIDER_IDS: LocalAgentProviderId[] = [
  "claude",
  "codex",
  "gemini",
  "antigravity",
];

export function isLocalAgentProviderId(value: string): value is LocalAgentProviderId {
  return (LOCAL_AGENT_PROVIDER_IDS as string[]).includes(value);
}

function baseUrl(): string {
  return process.env.LOCAL_AGENT_URL || "http://127.0.0.1:8787";
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = process.env.LOCAL_AGENT_TOKEN;
  if (!token) {
    throw new Error("LOCAL_AGENT_TOKEN is not set — local-agent providers are unavailable.");
  }
  return { Authorization: `Bearer ${token}`, ...extra };
}

export type AskRequest = {
  provider: LocalAgentProviderId;
  prompt: string;
  model?: string;
  session_id?: string;
  workdir?: string;
  no_tools?: boolean;
};

export type GatewayCallResult = { status: number; data: unknown };

export async function ask(req: AskRequest): Promise<GatewayCallResult> {
  const res = await fetch(`${baseUrl()}/ask`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(req),
  });
  return { status: res.status, data: await res.json() };
}

// Returns the raw upstream Response so its SSE body can be piped straight
// through to our own caller without buffering. Pass the incoming request's
// signal: aborting closes the connection to the gateway, which then kills the
// CLI's process tree instead of letting it run to completion unread.
export async function askStream(req: AskRequest, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl()}/ask/stream`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(req),
    signal,
  });
}

export type ImageRequest = {
  provider?: "codex";
  prompt: string;
  model?: string;
  images?: { data_base64: string; label?: string }[];
  workdir?: string;
};

export async function image(req: ImageRequest): Promise<GatewayCallResult> {
  const res = await fetch(`${baseUrl()}/image`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(req),
  });
  return { status: res.status, data: await res.json() };
}

export async function health(): Promise<GatewayCallResult> {
  const res = await fetch(`${baseUrl()}/health`, { headers: authHeaders() });
  return { status: res.status, data: await res.json() };
}

export async function models(): Promise<GatewayCallResult> {
  const res = await fetch(`${baseUrl()}/models`, { headers: authHeaders() });
  return { status: res.status, data: await res.json() };
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
};

// A run whose model the gateway never named (it failed or was stopped before
// the CLI said) is filed under the model asked for, else "default".
export function recordLocalRun(
  provider: LocalAgentProviderId,
  requestedModel: string | undefined,
  outcome: LocalRunOutcome
): void {
  recordUsageEvent(provider, outcome.model || requestedModel || "default", {
    status: outcome.status,
    usage: toOpenAIUsage(outcome.usage),
    durationMs: outcome.durationMs,
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
