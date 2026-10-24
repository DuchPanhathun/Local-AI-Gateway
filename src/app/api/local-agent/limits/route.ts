import { NextRequest, NextResponse } from "next/server";
import { limits } from "@/lib/local-agent";
import { checkAccess, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Owner-only, like /api/local-agent/health. The gateway caches the answer for
// 2 minutes; a fresh check takes a few seconds.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  try {
    const { status, data } = await limits();
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "local-agent-gateway is unreachable" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
