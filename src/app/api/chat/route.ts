import { NextRequest, NextResponse } from "next/server";
import { callProvider, isProviderId, PROVIDER_IDS } from "@/lib/ai-providers";
import { isValidGeneratedToken } from "@/lib/api-tokens";

// Hobby plan allows up to 60s per function invocation; SEA-LION responses
// can be slow, so opt into the max instead of the 10s default.
export const maxDuration = 60;

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

  try {
    const { status, data } = await callProvider(providerId, {
      messages,
      ...(payload.model ? { model: payload.model } : {}),
    });
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
