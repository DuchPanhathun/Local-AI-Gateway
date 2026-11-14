import { NextRequest, NextResponse } from "next/server";
import { callProvider } from "@/lib/ai-providers";
import { GOOGLE_DEFAULT_EMBEDDING_MODEL } from "@/lib/google-ai";
import { providerBlock } from "@/lib/provider-setup";
import { RateLimitedError, retryAfterHeaders } from "@/lib/rate-limits";
import { checkAccess, keyRule, refusal } from "@/lib/auth";
import { deductCreditForUsage, estimateTokens, getAccount, getAccountCredit, usedInPeriod } from "@/lib/api-tokens";

export const maxDuration = 120;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type EmbeddingsBody = {
  input?: unknown;
  model?: string;
  dimensions?: number;
  encoding_format?: string;
  [key: string]: unknown;
};

const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: CORS_HEADERS });

// Text embeddings, in OpenAI's /embeddings format: `input` (a string, or an array of them) and optional `model`
// (default gemini-embedding-001; also gemini-embedding-2), `dimensions` and `encoding_format`. Answered by Google
// AI Studio's embedding models over the GOOGLE_AI_STUDIO_API_KEY* keys, the same way chat is: the next key that
// has quota. Google reports no token counts for embeddings, so the answer gets an estimate (one token per four
// characters), which is also what is counted against a key's plan and charged.
export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  let payload: EmbeddingsBody;
  try {
    payload = await req.json();
  } catch {
    return fail("Request body must be valid JSON", 400);
  }
  const input = payload.input;
  const texts = typeof input === "string" ? [input] : Array.isArray(input) && input.every((t) => typeof t === "string") ? (input as string[]) : null;
  if (!texts || texts.length === 0 || texts.some((t) => !t)) {
    return fail("Provide `input`: a non-empty string, or an array of non-empty strings", 400);
  }

  const rule = keyRule(access, "google");
  if (rule.refused) return fail(rule.refused, 403);

  // The same gate as chat: an account with no credit and no plan tokens left is turned away.
  const account = access.who === "token" && access.key.userId ? await getAccount(access.key.userId) : null;
  const userCredit = account ? getAccountCredit(account) : 0;
  const hasPlanTokens =
    account &&
    account.limits.tokens !== null &&
    account.limits.tokens - usedInPeriod(account).tokens > 0 &&
    (!account.providers || account.providers.includes("google"));
  if (account && userCredit <= 0 && !hasPlanTokens) {
    return NextResponse.json(
      { error: "Insufficient credit balance. Please deposit funds on your account to continue.", creditBalance: userCredit },
      { status: 402, headers: CORS_HEADERS }
    );
  }

  const blocked = await providerBlock("google");
  if (blocked) return fail(blocked, 503);

  const model = typeof payload.model === "string" && payload.model ? payload.model : GOOGLE_DEFAULT_EMBEDDING_MODEL;
  const rest: Record<string, unknown> = { ...payload };
  delete rest.input;
  delete rest.model;
  delete rest.provider;

  try {
    const { status, data } = await callProvider("google", { ...rest, input, model }, rule.caller, {
      path: "/embeddings",
      model: GOOGLE_DEFAULT_EMBEDDING_MODEL,
    });
    const ok = status >= 200 && status < 300;
    const body = data as { usage?: { prompt_tokens?: number; total_tokens?: number } } | null;
    const tokens = estimateTokens(texts.reduce((n, t) => n + t.length, 0));
    if (ok && body && typeof body === "object" && !body.usage) body.usage = { prompt_tokens: tokens, total_tokens: tokens };
    if (ok && account && userCredit > 0) {
      await deductCreditForUsage(account.userId, "google", model, body?.usage?.prompt_tokens ?? tokens, 0);
    }
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
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
