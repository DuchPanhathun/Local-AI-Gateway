import { NextRequest, NextResponse } from "next/server";
import { transcribeWithGoogle, transcribeWithGroq } from "@/lib/ai-providers";
import { GOOGLE_DEFAULT_TRANSCRIBE_MODEL } from "@/lib/google-ai";
import { RateLimitedError, retryAfterHeaders } from "@/lib/rate-limits";
import { recordLocalRun, transcribeOnWeb } from "@/lib/local-agent";
import { providerBlock } from "@/lib/provider-setup";
import { checkAccess, keyRule, refusal, type KeyRule } from "@/lib/auth";

// Whisper on Groq answers in about a second, leaving room for trying every key;
// MiMo's ASR page takes 3–10 s.
export const maxDuration = 120;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// The fields Groq's /audio/transcriptions takes besides `file`; others are dropped.
const FORWARDED_FIELDS = [
  "model",
  "prompt",
  "response_format",
  "temperature",
  "language",
  "timestamp_granularities[]",
];

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Speech-to-text, in the same multipart format as OpenAI's and Groq's
// /audio/transcriptions: the audio in `file`, plus optional `model` (default
// GROQ_TRANSCRIBE_MODEL or whisper-large-v3-turbo), `prompt`, `language`,
// `response_format` and `temperature`. The answer is Groq's, e.g. { "text": "…" }.
// `provider=mimo` sends it to MiMo Studio's MiMo-V2.5-ASR page instead
// (through chatgpt-web-gateway; up to 10 MB and 90 s), answering { "text": "…" } too.
export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  let incoming: FormData;
  try {
    incoming = await req.formData();
  } catch {
    return badRequest("Send the audio as multipart/form-data, in a `file` field");
  }
  const file = incoming.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return badRequest("Send the audio as multipart/form-data, in a `file` field");
  }

  const provider = String(incoming.get("provider") || "groq");
  if (provider !== "groq" && provider !== "mimo" && provider !== "google") {
    return badRequest(`Unknown provider "${provider}". Supported: groq, mimo, google`);
  }
  const rule = keyRule(access, provider);
  if (rule.refused) {
    return NextResponse.json({ error: rule.refused }, { status: 403, headers: CORS_HEADERS });
  }
  if (provider === "mimo") return transcribeOnMimo(file, incoming, rule);
  if (provider === "google") return transcribeOnGoogle(file, incoming, rule);

  // Transcription runs on the Groq keys, so pausing Groq pauses it too.
  const blocked = await providerBlock("groq");
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 503, headers: CORS_HEADERS });
  }

  const form = new FormData();
  form.set("file", file, file instanceof File && file.name ? file.name : "audio.wav");
  for (const field of FORWARDED_FIELDS) {
    for (const value of incoming.getAll(field)) form.append(field, value);
  }

  try {
    const result = await transcribeWithGroq(form, rule.caller);
    const headers: Record<string, string> = { ...CORS_HEADERS, "Content-Type": result.contentType };
    if (result.retryAfter) headers["Retry-After"] = result.retryAfter;
    return new NextResponse(result.body, { status: result.status, headers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}

async function transcribeOnMimo(file: Blob, incoming: FormData, rule: KeyRule) {
  const blocked = await providerBlock("mimo");
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 503, headers: CORS_HEADERS });
  }
  const model = String(incoming.get("model") || "mimo-v2.5-asr");
  const filename = file instanceof File && file.name ? file.name : undefined;
  const caller = { id: rule.caller };
  try {
    const { status, data } = await transcribeOnWeb({
      provider: "mimo",
      model,
      audio_base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      ...(filename ? { filename } : {}),
    });
    const ok = status >= 200 && status < 300;
    const result = data as { duration_ms?: number };
    recordLocalRun("mimo", model, ok ? { status: "ok", model, durationMs: result.duration_ms } : { status: "error" }, caller);
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    recordLocalRun("mimo", model, { status: "error" }, caller);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chatgpt-web-gateway request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}

// Gemini 3.5 Transcribe over the Google keys. The audio goes inline (Google takes up to 20 MB in a request).
async function transcribeOnGoogle(file: Blob, incoming: FormData, rule: KeyRule) {
  const blocked = await providerBlock("google");
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 503, headers: CORS_HEADERS });
  }
  if (file.size > 14 * 1024 * 1024) return badRequest("Google takes audio up to about 14 MB in one request: send a shorter recording");
  const model = String(incoming.get("model") || GOOGLE_DEFAULT_TRANSCRIBE_MODEL);
  const prompt = String(incoming.get("prompt") || "");
  const language = String(incoming.get("language") || "");
  try {
    const result = await transcribeWithGoogle(file, { model, ...(prompt ? { prompt } : {}), ...(language ? { language } : {}) }, rule.caller);
    return new NextResponse(result.body, { status: result.status, headers: { ...CORS_HEADERS, "Content-Type": result.contentType } });
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
