import { NextRequest, NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/ai-providers";
import { getLocalUsageSnapshot } from "@/lib/local-agent";
import { getPausedProviders } from "@/lib/provider-state";
import { checkAccess, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Today's usage: `keys` per cloud API key (every configured key, used or
// not), `local` per local CLI and model (only those used today), plus which
// providers are paused.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  return NextResponse.json(
    {
      keys: getUsageSnapshot(),
      local: getLocalUsageSnapshot(),
      paused: await getPausedProviders(),
      generatedAt: new Date().toISOString(),
    },
    { headers: CORS_HEADERS }
  );
}
