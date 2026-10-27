import { NextRequest, NextResponse } from "next/server";
import { isProviderId, PROVIDER_IDS, streamProvider } from "@/lib/ai-providers";
import {
  askStream,
  isLocalAgentProviderId,
  lastUserMessage,
  LOCAL_AGENT_PROVIDER_IDS,
  recordLocalRun,
  relayStream,
} from "@/lib/local-agent";
import { isProviderPaused, pausedMessage } from "@/lib/provider-state";
import { bodyRetryAfter, RateLimitedError, retryAfterHeaders } from "@/lib/rate-limits";
import { checkAccess, keyRule, refusal } from "@/lib/auth";
import { withKeepAlive } from "@/lib/sse";
import { estimateTokens, getAccount, getAccountCredit, usedInPeriod } from "@/lib/api-tokens";
import { deductCreditForUsage } from "@/lib/api-tokens";

export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SSE_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type StreamRequestBody = {
  provider?: string;
  prompt?: string;
  messages?: unknown;
  model?: string;
  // local-agent providers only:
  session_id?: string;
  workdir?: string;
  no_tools?: boolean;
  temporary?: boolean; // chatgpt and grok (mimo always saves)
  // cloud providers: any other OpenAI-compatible field (max_tokens,
  // temperature, chat_template_kwargs, ...) is forwarded as-is.
  [key: string]: unknown;
};

// Every provider streams as the same Server-Sent Events: `start`, `delta`
// ({text}), `done` ({result, model, usage, ...}), `error` ({status, detail})
// — plus `thinking` ({text}) for cloud models that reason before answering.
// local-agent-gateway already speaks this format and is relayed nearly as-is
// (relayStream renames done.usage's fields); cloud providers' OpenAI-style
// chunks are converted by streamProvider.
export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  let payload: StreamRequestBody;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Same default as /api/chat.
  const providerId = payload.provider ?? "sea-lion";

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

  if (await isProviderPaused(providerId)) {
    return NextResponse.json(
      { error: pausedMessage(providerId) },
      { status: 503, headers: CORS_HEADERS }
    );
  }

  if (isLocalAgentProviderId(providerId)) {
    const prompt =
      typeof payload.prompt === "string" && payload.prompt
        ? payload.prompt
        : lastUserMessage(payload.messages);
    if (!prompt) {
      return NextResponse.json(
        { error: "Provide `prompt` (string) for local-agent providers" },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    const model = typeof payload.model === "string" && payload.model ? payload.model : undefined;
    const caller = { id: rule.caller, promptChars: prompt.length };

    try {
      const upstream = await askStream(
        {
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
        },
        req.signal
      );

      if (!upstream.ok || !upstream.body) {
        // Failures before the stream opens (401/400/403/429) are ordinary JSON errors.
        recordLocalRun(providerId, model, { status: "error" }, caller);
        const data = await upstream.json().catch(() => ({ error: "Upstream request failed" }));
        const headers = { ...CORS_HEADERS, ...retryAfterHeaders(bodyRetryAfter(data)) };
        return NextResponse.json(data, { status: upstream.status, headers });
      }

      const stream = relayStream(upstream.body, req.signal, async (outcome) => {
        recordLocalRun(providerId, model, outcome, caller);
        if (outcome.status === "ok" && account && userCredit > 0) {
          const promptTokens = outcome.usage?.input_tokens ?? estimateTokens(prompt.length);
          const completionTokens = outcome.usage?.output_tokens ?? estimateTokens(outcome.answerChars ?? 0);
          await deductCreditForUsage(
            account.userId,
            providerId,
            outcome.model || model,
            promptTokens,
            completionTokens
          );
        }
      });
      return new NextResponse(withKeepAlive(stream), { status: upstream.status, headers: SSE_HEADERS });
    } catch (err) {
      recordLocalRun(providerId, model, { status: req.signal.aborted ? "stopped" : "error" }, caller);
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
    : typeof payload.prompt === "string" && payload.prompt
      ? [{ role: "user", content: payload.prompt }]
      : null;
  if (!messages) {
    return NextResponse.json(
      { error: "Provide either `messages` (OpenAI-style array) or `prompt` (string)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const {
    provider: _provider,
    prompt: _prompt,
    messages: _messages,
    stream: _stream,
    stream_options: _streamOptions,
    session_id: _sessionId,
    workdir: _workdir,
    no_tools: _noTools,
    temporary: _temporary,
    ...rest
  } = payload;
  /* eslint-enable @typescript-eslint/no-unused-vars */

  try {
    const result = await streamProvider(providerId, { messages, ...rest }, req.signal, rule.caller);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: CORS_HEADERS });
    }
    return new NextResponse(withKeepAlive(result.stream), { headers: SSE_HEADERS });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return NextResponse.json(
        { error: err.message, ...(err.retryAfter !== undefined ? { retry_after: err.retryAfter } : {}) },
        { status: 429, headers: { ...CORS_HEADERS, ...retryAfterHeaders(err.retryAfter) } }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream request failed" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
