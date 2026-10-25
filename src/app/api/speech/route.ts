import { NextRequest, NextResponse } from "next/server";
import { recordLocalRun, speech, voices, type SpeechRequest } from "@/lib/local-agent";
import { isProviderPaused, pausedMessage } from "@/lib/provider-state";
import { checkAccess, refusal } from "@/lib/auth";

// MiMo's TTS page takes 5–15 s; a recording to copy has to upload first.
export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-Model, X-Voice, X-Duration-Ms",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// The speech and transcription models and the voices, from chatgpt-web-gateway.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  const { status, data } = await voices();
  return NextResponse.json(data, { status, headers: CORS_HEADERS });
}

type SpeechRequestBody = SpeechRequest & { response_format?: string };

// Text to speech on MiMo Studio's speech page, through chatgpt-web-gateway.
// Like OpenAI's /audio/speech: JSON in (`input`, `voice`, `instructions`,
// `model`), the audio file out (MiMo: WAV). `response_format: "json"` answers
// the gateway's JSON with the audio base64-encoded instead.
export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  let payload: SpeechRequestBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400, headers: CORS_HEADERS });
  }
  if (typeof payload.input !== "string" || !payload.input) {
    return NextResponse.json({ error: "Provide `input` (string): the text to speak" }, { status: 400, headers: CORS_HEADERS });
  }

  if (await isProviderPaused("mimo")) {
    return NextResponse.json({ error: pausedMessage("mimo") }, { status: 503, headers: CORS_HEADERS });
  }
  const { response_format: format, ...request } = payload;
  const model = typeof request.model === "string" && request.model ? request.model : "mimo-v2.5-tts";

  try {
    const { status, data } = await speech({ ...request, provider: "mimo", model });
    const ok = status >= 200 && status < 300;
    const result = data as { audio_base64?: string; mime_type?: string; voice?: string | null; duration_ms?: number };
    recordLocalRun("mimo", model, ok ? { status: "ok", model, durationMs: result.duration_ms } : { status: "error" });
    if (!ok || format === "json" || !result.audio_base64) {
      return NextResponse.json(data, { status, headers: CORS_HEADERS });
    }
    return new NextResponse(Buffer.from(result.audio_base64, "base64"), {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": result.mime_type || "audio/wav",
        "X-Model": model,
        ...(result.voice ? { "X-Voice": encodeURIComponent(result.voice) } : {}),
        ...(result.duration_ms !== undefined ? { "X-Duration-Ms": String(result.duration_ms) } : {}),
      },
    });
  } catch (err) {
    recordLocalRun("mimo", model, { status: "error" });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chatgpt-web-gateway request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
