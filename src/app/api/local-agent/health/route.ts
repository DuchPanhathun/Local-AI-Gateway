import { NextRequest, NextResponse } from "next/server";
import { health } from "@/lib/local-agent";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Owner-only, like /api/quotas and /api/tokens.
export async function GET(req: NextRequest) {
  const appKey = process.env.APP_API_KEY;
  if (appKey) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${appKey}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
    }
  }

  try {
    const { status, data } = await health();
    return NextResponse.json(data, { status, headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "local-agent-gateway is unreachable" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
