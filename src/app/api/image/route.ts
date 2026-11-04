import { NextRequest, NextResponse } from "next/server";
import { image as generateImage, recordLocalRun } from "@/lib/local-agent";
import { providerBlock } from "@/lib/provider-setup";
import { checkAccess, keyRule, refusal } from "@/lib/auth";

// Codex's image_gen tool reports ~75s per image; give it headroom.
export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type ImageRequestBody = {
  prompt?: string;
  model?: string;
  images?: { data_base64: string; label?: string }[];
  workdir?: string;
};

// Only Codex can generate images today (local-agent-gateway's own limitation,
// via its built-in image_gen tool under your ChatGPT login — no API key).
export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  let payload: ImageRequestBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (typeof payload.prompt !== "string" || !payload.prompt) {
    return NextResponse.json(
      { error: "Provide `prompt` (string)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const rule = keyRule(access, "codex", { image: true });
  if (rule.refused) {
    return NextResponse.json({ error: rule.refused }, { status: 403, headers: CORS_HEADERS });
  }
  const caller = { id: rule.caller, promptChars: payload.prompt.length };

  const blocked = await providerBlock("codex");
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 503, headers: CORS_HEADERS });
  }
  const model = typeof payload.model === "string" && payload.model ? payload.model : undefined;

  try {
    const { status, data } = await generateImage({
      provider: "codex",
      prompt: payload.prompt,
      ...(model ? { model } : {}),
      ...(payload.images ? { images: payload.images } : {}),
      ...(payload.workdir ? { workdir: payload.workdir } : {}),
    });
    const run = data as { model?: string | null; duration_ms?: number };
    recordLocalRun(
      "codex",
      model,
      status >= 200 && status < 300
        ? { status: "ok", model: run.model, durationMs: run.duration_ms }
        : { status: "error" },
      caller
    );
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    recordLocalRun("codex", model, { status: "error" }, caller);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "local-agent-gateway request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
