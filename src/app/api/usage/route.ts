import { NextRequest, NextResponse } from "next/server";
import { getMonthUsage, getUsageMonths, todayUTC } from "@/lib/usage-ledger";
import { checkAccess, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/usage?month=2026-10 → one month's usage across every provider
// (default: the current month, in UTC): totals, each model used with its
// requests and tokens (most tokens first), and a total for every day of the
// month. `months` lists the months there's usage for. Owner only, like
// /api/quotas.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  const month = req.nextUrl.searchParams.get("month") ?? todayUTC().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json(
      { error: "`month` must be a year and month, like 2026-10" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  return NextResponse.json(
    { ...getMonthUsage(month), months: getUsageMonths(), generatedAt: new Date().toISOString() },
    { headers: CORS_HEADERS }
  );
}
