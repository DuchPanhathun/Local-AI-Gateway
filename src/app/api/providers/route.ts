import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_IDS } from "@/lib/ai-providers";
import { LOCAL_AGENT_PROVIDER_IDS } from "@/lib/local-agent";
import { getPausedProviders, setProviderPaused } from "@/lib/provider-state";
import { checkAccess, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ALL_PROVIDERS: string[] = [...PROVIDER_IDS, ...LOCAL_AGENT_PROVIDER_IDS];

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Owner only: access tokens can call providers, not switch them off.
// GET → {paused: ["cerebras", ...]}
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  return NextResponse.json({ paused: await getPausedProviders() }, { headers: CORS_HEADERS });
}

// PATCH {provider, paused: true|false} pauses or resumes one provider and
// returns the new {paused: [...]} list. Takes effect on the next request.
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

  try {
    const list = await setProviderPaused(provider, paused);
    return NextResponse.json({ paused: list }, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: `Couldn't save the change: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
