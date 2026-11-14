import { NextRequest, NextResponse } from "next/server";
import { accountKeys, ensureAccount, monthUsage, ownKeySummary, summarizeAccount, usageMonths } from "@/lib/api-tokens";
import { publicOrigin } from "@/lib/auth";
import { getProviderState } from "@/lib/provider-setup";
import { checkUser } from "@/lib/supabase";
import { todayUTC } from "@/lib/usage-ledger";

// The account dashboard's (/account) API, for the signed-in user: the
// request carries their Supabase session's access token as
// `Authorization: Bearer …`. For the dashboard's own page only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/account?month=2026-10 → the user, their account (made, waiting to
// be activated, the first time they sign in), its keys, its use that month
// (default: this one) by day and model, the months it has use in, and
// `unavailable`: the providers turned away right now (paused, not set up, or
// failing their test chat), which the page leaves out of the models it lists.
export async function GET(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status, headers: NO_STORE });
  const { user } = who;

  const month = req.nextUrl.searchParams.get("month") ?? todayUTC().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ error: "`month` must be a year and month, like 2026-10" }, { status: 400, headers: NO_STORE });
  }
  const account = await ensureAccount(user);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { note: _note, ...summary } = summarizeAccount(account); // the owner's note is the owner's
  // Not worth failing the page over: without it every provider is listed, as before.
  const [keys, providers] = await Promise.all([accountKeys(user.id), getProviderState().catch(() => null)]);
  return NextResponse.json(
    {
      user: { id: user.id, email: user.email, admin: user.admin },
      account: summary,
      keys: keys.map(ownKeySummary),
      usage: monthUsage(account, month),
      months: usageMonths(account),
      publicOrigin: publicOrigin(),
      unavailable: providers?.paused ?? [],
    },
    { headers: NO_STORE }
  );
}
