import { NextRequest, NextResponse } from "next/server";
import { callGoogleNative, googleInteractions, googleKeyNames } from "@/lib/ai-providers";
import { GOOGLE_AGENT_MODEL, GOOGLE_DECISION_MODEL } from "@/lib/google-ai";
import { providerBlock } from "@/lib/provider-setup";
import { RateLimitedError, retryAfterHeaders } from "@/lib/rate-limits";
import { checkAccess, refusal } from "@/lib/auth";

export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: CORS_HEADERS });

// Google's own endpoints that the OpenAI-format routes don't cover, passed through over the Google keys (the same
// rotation, cooldowns and usage counting), for the owner key only:
//
//   POST   /api/google/decisions                     Gemini Decision 1
//   POST   /api/google/interactions                  Antigravity agents (`agent`), or a model (`model`)
//   GET    /api/google/interactions/{id}             an interaction, e.g. a background one still running
//   POST   /api/google/interactions/{id}:cancel
//   DELETE /api/google/interactions/{id}
//   POST   /api/google/models/{model}:generateContent | :countTokens | :embedContent | :batchEmbedContents
//
// Nothing else is passed: this is an allowlist, not a proxy for the whole API (no files, tuning or cached
// contents, no downloading an agent's sandbox files), and nothing streams (`background: true` and polling instead).
// An interaction, and the sandbox (`environment_id`) it ran in, live in the project of the key that made them, so the
// key's name is remembered with their ids and the follow-ups use it; after a restart the keys are tried one by one.
type Route = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  model: string;
  interactionId?: string;
  timeoutMs?: number;
  // Whether the model is asked to do something: reading, cancelling and deleting an interaction aren't counted.
  counted: boolean;
};

// An agent run is long: as long as this route may run.
const AGENT_TIMEOUT_MS = 280_000;

function route(method: string, parts: string[], body: Record<string, unknown> | undefined): Route | string {
  const path = parts.join("/");
  if (method === "POST" && path === "decisions") {
    return { method, path, model: typeof body?.model === "string" ? body.model : GOOGLE_DECISION_MODEL, counted: true };
  }
  if (method === "POST" && path === "interactions") {
    const model = typeof body?.agent === "string" ? body.agent : typeof body?.model === "string" ? body.model : GOOGLE_AGENT_MODEL;
    return { method, path, model, timeoutMs: AGENT_TIMEOUT_MS, counted: true };
  }
  const interaction = /^interactions\/([A-Za-z0-9_-]+)(:cancel)?$/.exec(path);
  if (interaction) {
    const cancel = Boolean(interaction[2]);
    if ((cancel && method === "POST") || (!cancel && (method === "GET" || method === "DELETE"))) {
      return { method: method as Route["method"], path, model: GOOGLE_AGENT_MODEL, interactionId: interaction[1], counted: false };
    }
    return `${path}: use ${cancel ? "POST" : "GET or DELETE"}`;
  }
  const generate = /^models\/([A-Za-z0-9._-]+):(generateContent|countTokens|embedContent|batchEmbedContents)$/.exec(path);
  if (generate) {
    if (method !== "POST") return `${path}: use POST`;
    return { method, path, model: generate[1], counted: generate[2] !== "countTokens" };
  }
  return `Not a Google endpoint this gateway passes: ${method} ${path}`;
}

async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  const { path: parts } = await params;
  let body: Record<string, unknown> | undefined;
  if (req.method === "POST") {
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("Request body must be a JSON object", 400);
      body = parsed as Record<string, unknown>;
    } catch {
      return fail("Request body must be valid JSON", 400);
    }
  }
  const target = route(req.method, parts, body);
  if (typeof target === "string") return fail(target, 404);

  const blocked = await providerBlock("google");
  if (blocked) return fail(blocked, 503);

  // The key an interaction was made with: its own id, the one it continues, or the sandbox it runs in.
  const sandbox = typeof body?.environment === "string" && body.environment !== "remote" ? body.environment : undefined;
  const ids = [target.interactionId, body?.previous_interaction_id, sandbox].filter((id): id is string => typeof id === "string" && id !== "");
  const followUp = ids[0];
  const known = ids.map((id) => googleInteractions.get(id)).find((name) => name !== undefined);
  const chars = body ? JSON.stringify(body).length : 0;
  const send = (keyName?: string) =>
    callGoogleNative({
      method: target.method,
      path: target.path,
      ...(body ? { body } : {}),
      model: target.model,
      ...(target.timeoutMs ? { timeoutMs: target.timeoutMs } : {}),
      count: target.counted,
      chars,
      caller: undefined,
      ...(keyName ? { keyName } : {}),
    });

  try {
    let result = await send(known);
    // Not seen since the last restart: ask the keys one by one, for the one that knows it.
    if (!known && followUp && result.status === 404) {
      for (const name of googleKeyNames()) {
        if (name === result.keyName) continue;
        const attempt = await send(name);
        if (attempt.status !== 404) {
          result = attempt;
          break;
        }
      }
    }
    if (result.status < 400) {
      const data = result.data as { id?: unknown; environment_id?: unknown } | null;
      if (target.path === "interactions") {
        googleInteractions.remember(data?.id, result.keyName);
        googleInteractions.remember(data?.environment_id, result.keyName);
      }
      if (followUp && !known) for (const id of ids) googleInteractions.remember(id, result.keyName);
    }
    return NextResponse.json(result.data, { status: result.status, headers: CORS_HEADERS });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return NextResponse.json(
        { error: err.message, ...(err.retryAfter !== undefined ? { retry_after: err.retryAfter } : {}) },
        { status: 429, headers: { ...CORS_HEADERS, ...retryAfterHeaders(err.retryAfter) } }
      );
    }
    return fail(err instanceof Error ? err.message : "Upstream request failed", 502);
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
