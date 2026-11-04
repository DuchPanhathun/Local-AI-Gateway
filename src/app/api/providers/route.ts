import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_IDS } from "@/lib/ai-providers";
import { LOCAL_AGENT_PROVIDER_IDS } from "@/lib/local-agent";
import { setProviderPaused } from "@/lib/provider-state";
import { runCheck } from "@/lib/provider-check";
import { getProviderState, isBlocked, staticSetup } from "@/lib/provider-setup";
import { checkAccess, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ALL_PROVIDERS: string[] = [...PROVIDER_IDS, ...LOCAL_AGENT_PROVIDER_IDS];

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Owner only: access tokens can call providers, not switch them off.
// GET → {paused, manual, setup, checks}: `paused` has the providers that turn
// requests away: those the owner paused (`manual`), those that aren't set up
// (no API key, CLI not installed or signed out) and those whose test chat
// failed. `setup` says why for each, and `checks` has what the test chats and
// real requests have shown (see lib/provider-check.ts).
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  return NextResponse.json(await getProviderState(), { headers: CORS_HEADERS });
}

// PATCH {provider, paused: true|false} pauses or resumes one provider and
// returns the new state. Takes effect on the next request. A provider that
// isn't set up can't be resumed: 409, with the reason. Resuming starts a test
// chat, and a provider that fails it is held again.
export async function PATCH(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  let body: { provider?: unknown; paused?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { provider, paused } = body;
  if (typeof provider !== "string" || !ALL_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: `Unknown provider "${String(provider ?? "")}". Supported: ${ALL_PROVIDERS.join(", ")}` },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  if (typeof paused !== "boolean") {
    return NextResponse.json(
      { error: "Provide `paused` (true or false)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (!paused) {
    const setup = await staticSetup(provider, true); // a fresh answer: this decides
    if (isBlocked(setup)) {
      return NextResponse.json(
        { error: `Can't resume "${provider}": ${setup.reason}` },
        { status: 409, headers: CORS_HEADERS }
      );
    }
  }

  try {
    await setProviderPaused(provider, paused);
    if (!paused) void runCheck(provider);
    return NextResponse.json(await getProviderState(), { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: `Couldn't save the change: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

// POST {provider, wait?} tests one provider with a real, tiny chat, and a
// provider that fails is held until a later test passes. Answers 202 with the
// state at once (`checks[provider].testing` is true until it's over; GET shows
// when), or with `wait: true` after the test, which can take a minute or more.
// Not for a provider that isn't set up: 409, with the reason.
export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  const body = (await req.json().catch(() => null)) as { provider?: unknown; wait?: unknown } | null;
  const provider = body?.provider;
  if (typeof provider !== "string" || !ALL_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: `Unknown provider "${String(provider ?? "")}". Supported: ${ALL_PROVIDERS.join(", ")}` },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  const setup = await staticSetup(provider, true);
  if (isBlocked(setup)) {
    return NextResponse.json(
      { error: `Nothing to test: "${provider}" isn't set up. ${setup.reason}` },
      { status: 409, headers: CORS_HEADERS }
    );
  }

  const test = runCheck(provider);
  if (body?.wait === true) await test;
  return NextResponse.json(await getProviderState(), { status: body?.wait === true ? 200 : 202, headers: CORS_HEADERS });
}
