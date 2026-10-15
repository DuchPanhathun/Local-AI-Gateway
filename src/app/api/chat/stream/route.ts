import { NextRequest, NextResponse } from "next/server";
import { isProviderId, PROVIDER_IDS, streamProvider } from "@/lib/ai-providers";
import { isValidGeneratedToken } from "@/lib/api-tokens";
import {
  askStream,
  isLocalAgentProviderId,
  LOCAL_AGENT_PROVIDER_IDS,
  recordLocalRun,
  relayStream,
} from "@/lib/local-agent";
import { isProviderPaused, pausedMessage } from "@/lib/provider-state";

export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SSE_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type StreamRequestBody = {
  provider?: string;
  prompt?: string;
  messages?: unknown;
  model?: string;
  // local-agent providers only:
  session_id?: string;
  workdir?: string;
  no_tools?: boolean;
  // cloud providers: any other OpenAI-compatible field (max_tokens,
  // temperature, chat_template_kwargs, ...) is forwarded as-is.
  [key: string]: unknown;
};

// Every provider streams as the same Server-Sent Events: `start`, `delta`
// ({text}), `done` ({result, model, usage, ...}), `error` ({status, detail})
// — plus `thinking` ({text}) for cloud models that reason before answering.
// local-agent-gateway already speaks this format and is relayed nearly as-is
// (relayStream renames done.usage's fields); cloud providers' OpenAI-style
// chunks are converted by streamProvider.
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

  let payload: StreamRequestBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const providerId = payload.provider;

  if (providerId && (await isProviderPaused(providerId))) {
    return NextResponse.json(
      { error: pausedMessage(providerId) },
      { status: 503, headers: CORS_HEADERS }
    );
  }

  if (providerId && isLocalAgentProviderId(providerId)) {
    if (typeof payload.prompt !== "string" || !payload.prompt) {
      return NextResponse.json(
        { error: "Provide `prompt` (string)" },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    const model = typeof payload.model === "string" && payload.model ? payload.model : undefined;

    try {
      const upstream = await askStream(
        {
          provider: providerId,
          prompt: payload.prompt,
          ...(model ? { model } : {}),
          ...(payload.session_id ? { session_id: payload.session_id } : {}),
          ...(payload.workdir ? { workdir: payload.workdir } : {}),
          ...(payload.no_tools !== undefined ? { no_tools: Boolean(payload.no_tools) } : {}),
        },
        req.signal
      );

      if (!upstream.ok || !upstream.body) {
        // Failures before the stream opens (401/400/403/429) are ordinary JSON errors.
        recordLocalRun(providerId, model, { status: "error" });
        const data = await upstream.json().catch(() => ({ error: "Upstream request failed" }));
        return NextResponse.json(data, { status: upstream.status, headers: CORS_HEADERS });
      }

      const stream = relayStream(upstream.body, req.signal, (outcome) =>
        recordLocalRun(providerId, model, outcome)
      );
      return new NextResponse(stream, { status: upstream.status, headers: SSE_HEADERS });
    } catch (err) {
      recordLocalRun(providerId, model, { status: req.signal.aborted ? "stopped" : "error" });
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "local-agent-gateway request failed" },
        { status: 502, headers: CORS_HEADERS }
      );
    }
  }

  if (!providerId || !isProviderId(providerId)) {
    return NextResponse.json(
      {
        error: `Unknown provider "${providerId ?? ""}". Supported: ${[
          ...PROVIDER_IDS,
          ...LOCAL_AGENT_PROVIDER_IDS,
        ].join(", ")}`,
      },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : typeof payload.prompt === "string" && payload.prompt
      ? [{ role: "user", content: payload.prompt }]
      : null;
  if (!messages) {
    return NextResponse.json(
      { error: "Provide either `messages` (OpenAI-style array) or `prompt` (string)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const {
    provider: _provider,
    prompt: _prompt,
    messages: _messages,
    stream: _stream,
    stream_options: _streamOptions,
    session_id: _sessionId,
    workdir: _workdir,
    no_tools: _noTools,
    ...rest
  } = payload;
  /* eslint-enable @typescript-eslint/no-unused-vars */

  try {
    const result = await streamProvider(providerId, { messages, ...rest }, req.signal);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: CORS_HEADERS });
    }
    return new NextResponse(result.stream, { headers: SSE_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
