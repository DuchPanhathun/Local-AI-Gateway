import { NextRequest, NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/ai-providers";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const appKey = process.env.APP_API_KEY;
  if (appKey) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${appKey}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
    }
  }

  return NextResponse.json(
    { keys: getUsageSnapshot(), generatedAt: new Date().toISOString() },
    { headers: CORS_HEADERS }
  );
}
