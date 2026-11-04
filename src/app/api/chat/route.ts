import { NextRequest, NextResponse } from "next/server";
import { callProvider, isProviderId, PROVIDER_IDS } from "@/lib/ai-providers";
import {
  ask as askLocalAgent,
  isLocalAgentProviderId,
  lastUserMessage,
  LOCAL_AGENT_PROVIDER_IDS,
  normalizeAskResponse,
  recordLocalRun,
  type GatewayUsage,
} from "@/lib/local-agent";
import { noteChatOutcome } from "@/lib/provider-check";
import { providerBlock } from "@/lib/provider-setup";
import { bodyRetryAfter, RateLimitedError, retryAfterHeaders } from "@/lib/rate-limits";
import { checkAccess, keyRule, refusal } from "@/lib/auth";
import { estimateTokens, getAccount, getAccountCredit, usedInPeriod } from "@/lib/api-tokens";
import { deductCreditForUsage } from "@/lib/api-tokens";

// With Fluid Compute (enabled on this project) the Hobby plan allows up to
// 300s per invocation, not the pre-Fluid 60s cap — reasoning models like
// SEA-LION can genuinely take well over a minute on longer prompts. Local
// agent CLIs can also run long; local-agent-gateway's own REQUEST_TIMEOUT_S
// (default 300) is the real cap on that side.
export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type ChatRequestBody = {
  messages?: unknown;
  prompt?: string;
  model?: string;
  provider?: string;
  // local-agent providers only:
  session_id?: string;
  workdir?: string;
  no_tools?: boolean;
  temporary?: boolean; // chatgpt and grok (mimo always saves)
  // Any other OpenAI-compatible field (max_tokens, temperature, response_format,
  // reasoning_effort, chat_template_kwargs, top_p, ...) is forwarded as-is to
  // cloud providers — see the passthrough below. `stream` is deliberately
  // excluded there since this endpoint always returns a single materialized
  // JSON response; use /api/chat/stream for local-agent streaming.
  [key: string]: unknown;
};

const DEFAULT_PROVIDER = "sea-lion";

export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  let payload: ChatRequestBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const providerId = payload.provider ?? DEFAULT_PROVIDER;

  const rule = keyRule(access, providerId);
  if (rule.refused) {
    return NextResponse.json({ error: rule.refused }, { status: 403, headers: CORS_HEADERS });
  }

  // Verify positive credit balance or active token plan
  const account =
    access.who === "token" && access.key.userId ? await getAccount(access.key.userId) : null;
  const userCredit = account ? getAccountCredit(account) : 0;
  const hasPlanTokens =
    account &&
    account.limits.tokens !== null &&
    account.limits.tokens - usedInPeriod(account).tokens > 0 &&
    (!account.providers || account.providers.includes(providerId));

  if (account && userCredit <= 0 && !hasPlanTokens) {
    return NextResponse.json(
      {
        error: "Insufficient credit balance. Please deposit funds on your account to continue.",
        creditBalance: userCredit,
      },
      { status: 402, headers: CORS_HEADERS }
    );
  }

  const blocked = await providerBlock(providerId);
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 503, headers: CORS_HEADERS });
  }

  if (isLocalAgentProviderId(providerId)) {
    const prompt =
      typeof payload.prompt === "string" ? payload.prompt : lastUserMessage(payload.messages);
    if (!prompt) {
      return NextResponse.json(
        { error: "Provide `prompt` (string) for local-agent providers" },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    const model = typeof payload.model === "string" && payload.model ? payload.model : undefined;
    const caller = { id: rule.caller, promptChars: prompt.length };

    try {
      const { status, data } = await askLocalAgent({
        provider: providerId,
        prompt,
        ...(model ? { model } : {}),
        ...(payload.session_id ? { session_id: payload.session_id } : {}),
        // A key without agent access: no tools, and the default workdir.
        ...(payload.workdir && !rule.sandboxed ? { workdir: payload.workdir } : {}),
        ...(rule.sandboxed
          ? { no_tools: true }
          : payload.no_tools !== undefined
            ? { no_tools: Boolean(payload.no_tools) }
            : {}),
        ...(payload.temporary !== undefined ? { temporary: Boolean(payload.temporary) } : {}),
      });
      noteChatOutcome(providerId, status);
      const ok = status >= 200 && status < 300;
      const run = data as {
        model?: string | null;
        result?: string;
        usage?: GatewayUsage | null;
        duration_ms?: number;
      };
      recordLocalRun(
        providerId,
        model,
        ok
          ? {
              status: "ok",
              model: run.model,
              usage: run.usage,
              durationMs: run.duration_ms,
              answerChars: run.result?.length,
            }
          : { status: "error" },
        caller
      );
      if (ok && account && userCredit > 0) {
        const promptTokens = run.usage?.input_tokens ?? estimateTokens(prompt.length);
        const completionTokens = run.usage?.output_tokens ?? estimateTokens(run.result?.length ?? 0);
        await deductCreditForUsage(
          account.userId,
          providerId,
          run.model || model,
          promptTokens,
          completionTokens
        );
      }
      const body = ok ? normalizeAskResponse(data) : data;
      // A CLI's usage limit is a 429 whose body says when it resets.
      const headers = { ...CORS_HEADERS, ...retryAfterHeaders(ok ? undefined : bodyRetryAfter(data)) };
      return NextResponse.json(body, { status, headers });
    } catch (err) {
      noteChatOutcome(providerId, 502);
      recordLocalRun(providerId, model, { status: "error" }, caller);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "local-agent-gateway request failed" },
        { status: 502, headers: CORS_HEADERS }
      );
    }
  }

  if (!isProviderId(providerId)) {
    return NextResponse.json(
      {
        error: `Unknown provider "${providerId}". Supported: ${[
          ...PROVIDER_IDS,
          ...LOCAL_AGENT_PROVIDER_IDS,
        ].join(", ")}`,
      },
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { provider: _provider, prompt: _prompt, messages: _messages, stream: _stream, ...rest } =
    payload;

  try {
    const { status, data } = await callProvider(providerId, { messages, ...rest }, rule.caller);
    noteChatOutcome(providerId, status);
    if (status >= 200 && status < 300 && account && userCredit > 0) {
      const u = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
      const answer = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      const promptChars = typeof payload.prompt === "string" ? payload.prompt.length : JSON.stringify(messages).length;
      const answerChars = typeof answer === "string" ? answer.length : 0;
      const promptTokens = u?.prompt_tokens ?? estimateTokens(promptChars);
      const completionTokens = u?.completion_tokens ?? estimateTokens(answerChars);
      const modelName = (data as { model?: string })?.model || (payload.model as string | undefined);
      await deductCreditForUsage(account.userId, providerId, modelName, promptTokens, completionTokens);
    }
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return NextResponse.json(
        { error: err.message, ...(err.retryAfter !== undefined ? { retry_after: err.retryAfter } : {}) },
        { status: 429, headers: { ...CORS_HEADERS, ...retryAfterHeaders(err.retryAfter) } }
      );
    }
    noteChatOutcome(providerId, 502);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
