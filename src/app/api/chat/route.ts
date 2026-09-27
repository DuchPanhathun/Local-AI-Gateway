import { NextRequest, NextResponse } from "next/server";
import { callProvider, isProviderId, PROVIDER_IDS } from "@/lib/ai-providers";
import { isValidGeneratedToken } from "@/lib/api-tokens";

// With Fluid Compute (enabled on this project) the Hobby plan allows up to
// 300s per invocation, not the pre-Fluid 60s cap — reasoning models like
// SEA-LION can genuinely take well over a minute on longer prompts.
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
  // Any other OpenAI-compatible field (max_tokens, temperature, response_format,
  // reasoning_effort, chat_template_kwargs, top_p, ...) is forwarded as-is —
  // see the passthrough below. `stream` is deliberately excluded there since
  // this endpoint always returns a single materialized JSON response.
  [key: string]: unknown;
};

const DEFAULT_PROVIDER = "sea-lion";

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

  const providerId = payload.provider ?? DEFAULT_PROVIDER;
  if (!isProviderId(providerId)) {
    return NextResponse.json(
      { error: `Unknown provider "${providerId}". Supported: ${PROVIDER_IDS.join(", ")}` },
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
