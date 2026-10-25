import { NextRequest, NextResponse } from "next/server";
import { transcribeWithGroq } from "@/lib/ai-providers";
import { recordLocalRun, transcribeOnWeb } from "@/lib/local-agent";
import { isProviderPaused, pausedMessage } from "@/lib/provider-state";
import { checkAccess, refusal } from "@/lib/auth";

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
  if (provider === "mimo") return transcribeOnMimo(file, incoming);
  if (provider !== "groq") return badRequest(`Unknown provider "${provider}". Supported: groq, mimo`);

  // Transcription runs on the Groq keys, so pausing Groq pauses it too.
  if (await isProviderPaused("groq")) {
    return NextResponse.json({ error: pausedMessage("groq") }, { status: 503, headers: CORS_HEADERS });
  }

  const form = new FormData();
  form.set("file", file, file instanceof File && file.name ? file.name : "audio.wav");
  for (const field of FORWARDED_FIELDS) {
    for (const value of incoming.getAll(field)) form.append(field, value);
  }

  try {
    const result = await transcribeWithGroq(form);
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

async function transcribeOnMimo(file: Blob, incoming: FormData) {
  if (await isProviderPaused("mimo")) {
    return NextResponse.json({ error: pausedMessage("mimo") }, { status: 503, headers: CORS_HEADERS });
  }
  const model = String(incoming.get("model") || "mimo-v2.5-asr");
  const filename = file instanceof File && file.name ? file.name : undefined;
  try {
    const { status, data } = await transcribeOnWeb({
      provider: "mimo",
      model,
      audio_base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      ...(filename ? { filename } : {}),
    });
    const ok = status >= 200 && status < 300;
    const result = data as { duration_ms?: number };
    recordLocalRun("mimo", model, ok ? { status: "ok", model, durationMs: result.duration_ms } : { status: "error" });
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    recordLocalRun("mimo", model, { status: "error" });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chatgpt-web-gateway request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
