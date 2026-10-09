import { NextRequest, NextResponse } from "next/server";
import { transcribeWithGroq } from "@/lib/ai-providers";
import { isValidGeneratedToken } from "@/lib/api-tokens";

// Whisper on Groq answers in about a second; this leaves room for trying every key.
export const maxDuration = 60;

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

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
}

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
