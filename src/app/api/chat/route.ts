import { NextRequest, NextResponse } from "next/server";
import { callProvider, isProviderId, PROVIDER_IDS } from "@/lib/ai-providers";
import { isValidGeneratedToken } from "@/lib/api-tokens";
import {
  ask as askLocalAgent,
  isLocalAgentProviderId,
  LOCAL_AGENT_PROVIDER_IDS,
  normalizeAskResponse,
  recordLocalRun,
  type GatewayUsage,
} from "@/lib/local-agent";
import { isProviderPaused, pausedMessage } from "@/lib/provider-state";

// With Fluid Compute (enabled on this project) the Hobby plan allows up to
// 300s per invocation, not the pre-Fluid 60s cap — reasoning models like
// SEA-LION can genuinely take well over a minute on longer prompts. Local
// agent CLIs can also run long; local-agent-gateway's own REQUEST_TIMEOUT_S
// (default 300) is the real cap on that side.
export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type ChatRequestBody = {
  messages?: unknown;
  prompt?: string;
  model?: string;
  provider?: string;
  // local-agent providers only:
  session_id?: string;
  workdir?: string;
  no_tools?: boolean;
  // Any other OpenAI-compatible field (max_tokens, temperature, response_format,
  // reasoning_effort, chat_template_kwargs, top_p, ...) is forwarded as-is to
  // cloud providers — see the passthrough below. `stream` is deliberately
  // excluded there since this endpoint always returns a single materialized
  // JSON response; use /api/chat/stream for local-agent streaming.
  [key: string]: unknown;
};

const DEFAULT_PROVIDER = "sea-lion";

// local-agent providers take a single prompt string, not a messages array —
// if the caller only sent `messages`, fall back to the last user turn's text.
function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && "content" in m && typeof m.content === "string") {
      return m.content;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const appKey = process.env.APP_API_KEY;
  if (appKey) {
    const auth = req.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const isOwner = bearer === appKey;
    const isGeneratedToken = !isOwner && !!bearer && (await isValidGeneratedToken(bearer));
    if (!isOwner && !isGeneratedToken) {
      return unauthorized();
    }
  }

  let payload: ChatRequestBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const providerId = payload.provider ?? DEFAULT_PROVIDER;

  if (await isProviderPaused(providerId)) {
    return NextResponse.json(
      { error: pausedMessage(providerId) },
      { status: 503, headers: CORS_HEADERS }
    );
  }

  if (isLocalAgentProviderId(providerId)) {
    const prompt =
      typeof payload.prompt === "string" ? payload.prompt : lastUserText(payload.messages);
    if (!prompt) {
      return NextResponse.json(
        { error: "Provide `prompt` (string) for local-agent providers" },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    const model = typeof payload.model === "string" && payload.model ? payload.model : undefined;

    try {
      const { status, data } = await askLocalAgent({
        provider: providerId,
        prompt,
        ...(model ? { model } : {}),
        ...(payload.session_id ? { session_id: payload.session_id } : {}),
        ...(payload.workdir ? { workdir: payload.workdir } : {}),
        ...(payload.no_tools !== undefined ? { no_tools: Boolean(payload.no_tools) } : {}),
      });
      const ok = status >= 200 && status < 300;
      const run = data as { model?: string | null; usage?: GatewayUsage | null; duration_ms?: number };
      recordLocalRun(
        providerId,
        model,
        ok
          ? { status: "ok", model: run.model, usage: run.usage, durationMs: run.duration_ms }
          : { status: "error" }
      );
      const body = ok ? normalizeAskResponse(data) : data;
      return NextResponse.json(body, { status, headers: CORS_HEADERS });
    } catch (err) {
      recordLocalRun(providerId, model, { status: "error" });
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "local-agent-gateway request failed" },
        { status: 502, headers: CORS_HEADERS }
      );
    }
  }

  if (!isProviderId(providerId)) {
    return NextResponse.json(
      {
        error: `Unknown provider "${providerId}". Supported: ${[
          ...PROVIDER_IDS,
          ...LOCAL_AGENT_PROVIDER_IDS,
        ].join(", ")}`,
      },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : typeof payload.prompt === "string"
      ? [{ role: "user", content: payload.prompt }]
      : null;

  if (!messages) {
    return NextResponse.json(
      { error: "Provide either `messages` (OpenAI-style array) or `prompt` (string)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { provider: _provider, prompt: _prompt, messages: _messages, stream: _stream, ...rest } =
    payload;

  try {
    const { status, data } = await callProvider(providerId, {
      messages,
      ...rest,
    });
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
