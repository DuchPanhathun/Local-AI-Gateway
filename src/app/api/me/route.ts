import { NextRequest, NextResponse } from "next/server";
import { holderView } from "@/lib/api-tokens";
import { checkAccess, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/me → the access token you're calling with: its status and limits,
// what it has used and has left this period (and in all), when the period
// starts over, and when the key expires. It answers even when the key is
// turned off, expired or used up, so its holder can see why they're refused.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "self");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  if (access.who === "owner") {
    return NextResponse.json({ owner: true, status: "active" }, { headers: CORS_HEADERS });
  }
  return NextResponse.json(holderView(access.key), { headers: CORS_HEADERS });
}
