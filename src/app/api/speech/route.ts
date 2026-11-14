import { NextRequest, NextResponse } from "next/server";
import { speakWithGoogle } from "@/lib/ai-providers";
import { GOOGLE_DEFAULT_SPEECH_MODEL, GOOGLE_MODELS, GOOGLE_VOICES } from "@/lib/google-ai";
import { recordLocalRun, speech, voices, type SpeechRequest } from "@/lib/local-agent";
import { providerBlock } from "@/lib/provider-setup";
import { RateLimitedError, retryAfterHeaders } from "@/lib/rate-limits";
import { checkAccess, keyRule, refusal } from "@/lib/auth";

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
  // `?provider=google`: Gemini's speech models and their voices.
  if (req.nextUrl.searchParams.get("provider") === "google") {
    const models = GOOGLE_MODELS.filter((m) => m.kind === "speech").map((m) => ({ id: m.id, name: m.name, limits: m.limits }));
    return NextResponse.json({ default: GOOGLE_DEFAULT_SPEECH_MODEL, models, voices: GOOGLE_VOICES }, { headers: CORS_HEADERS });
  }
  const { status, data } = await voices();
  return NextResponse.json(data, { status, headers: CORS_HEADERS });
}

type SpeechRequestBody = Omit<SpeechRequest, "provider"> & { provider?: string; response_format?: string };

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

  // Gemini TTS: `provider: "google"`, or a Gemini speech model named as the model.
  if (payload.provider === "google" || /^gemini-.*tts/i.test(String(payload.model ?? ""))) {
    return speakOnGoogle(access, payload);
  }

  const rule = keyRule(access, "mimo");
  if (rule.refused) {
    return NextResponse.json({ error: rule.refused }, { status: 403, headers: CORS_HEADERS });
  }
  // Speech counts as requests: its text isn't charged as tokens.
  const caller = { id: rule.caller };

  const blocked = await providerBlock("mimo");
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 503, headers: CORS_HEADERS });
  }
  const { response_format: format, ...withProvider } = payload;
  const request: SpeechRequest = { ...withProvider, provider: "mimo" };
  const model = typeof request.model === "string" && request.model ? request.model : "mimo-v2.5-tts";

  try {
    const { status, data } = await speech({ ...request, provider: "mimo", model });
    const ok = status >= 200 && status < 300;
    const result = data as { audio_base64?: string; mime_type?: string; voice?: string | null; duration_ms?: number };
    recordLocalRun("mimo", model, ok ? { status: "ok", model, durationMs: result.duration_ms } : { status: "error" }, caller);
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
    recordLocalRun("mimo", model, { status: "error" }, caller);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chatgpt-web-gateway request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}

// Text to speech with Gemini: the same request and answer as MiMo's, over the Google keys. The audio is a WAV file
// whichever format Google used; `response_format: "json"` answers it base64-encoded instead.
async function speakOnGoogle(access: Extract<Awaited<ReturnType<typeof checkAccess>>, { ok: true }>, payload: SpeechRequestBody) {
  const rule = keyRule(access, "google");
  if (rule.refused) {
    return NextResponse.json({ error: rule.refused }, { status: 403, headers: CORS_HEADERS });
  }
  const blocked = await providerBlock("google");
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 503, headers: CORS_HEADERS });
  }
  const model = typeof payload.model === "string" && payload.model ? payload.model : GOOGLE_DEFAULT_SPEECH_MODEL;
  const voice = typeof payload.voice === "string" && payload.voice ? payload.voice : "Kore";
  try {
    const result = await speakWithGoogle(
      { input: payload.input, model, voice, ...(payload.instructions ? { instructions: payload.instructions } : {}) },
      rule.caller
    );
    if (!result.wav) return NextResponse.json(result.data, { status: result.status, headers: CORS_HEADERS });
    if (payload.response_format === "json") {
      return NextResponse.json(
        { audio_base64: Buffer.from(result.wav).toString("base64"), mime_type: "audio/wav", model, voice, duration_ms: result.durationMs },
        { headers: CORS_HEADERS }
      );
    }
    return new NextResponse(Buffer.from(result.wav), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "audio/wav",
        "X-Model": model,
        "X-Voice": encodeURIComponent(voice),
        ...(result.durationMs !== undefined ? { "X-Duration-Ms": String(result.durationMs) } : {}),
      },
    });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return NextResponse.json(
        { error: err.message, ...(err.retryAfter !== undefined ? { retry_after: err.retryAfter } : {}) },
        { status: 429, headers: { ...CORS_HEADERS, ...retryAfterHeaders(err.retryAfter) } }
      );
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upstream request failed" }, { status: 502, headers: CORS_HEADERS });
  }
}
