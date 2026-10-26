import { NextRequest, NextResponse } from "next/server";
import { ensureAccount, summarizeAccount } from "@/lib/api-tokens";
import { lockedFor, recordFailure, recordSuccess } from "@/lib/auth";
import { redeem, RedeemError } from "@/lib/redeem-codes";
import { checkUser } from "@/lib/supabase";

// POST /api/account/redeem {"code": "K7QM-2XHD-9WPB"}: the signed-in user
// (Bearer: their Supabase access token) redeems a code on their account.
// Wrong codes count like wrong keys: 10 in 10 minutes and redeeming is
// refused for 15. For the dashboard's own page only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status: number, error: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

export async function POST(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  const { user } = who;

  const lockout = `redeem:${user.id}`;
  const wait = lockedFor(lockout);
  if (wait) {
    const seconds = Math.ceil(wait / 1000);
    return fail(429, `Too many wrong codes: try again in ${Math.ceil(seconds / 60)} minutes.`, { "Retry-After": String(seconds) });
  }

  let text = "";
  try {
    const body = (await req.json()) as { code?: unknown };
    text = typeof body.code === "string" ? body.code.slice(0, 100) : "";
  } catch {
    return fail(400, "Request body must be valid JSON");
  }

  await ensureAccount(user);
  try {
    const applied = await redeem(user, text);
    recordSuccess(lockout);
    const account = await ensureAccount(user);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { note: _note, ...summary } = summarizeAccount(account); // the owner's note is the owner's
    return NextResponse.json({ applied, account: summary }, { headers: NO_STORE });
  } catch (err) {
    if (!(err instanceof RedeemError)) throw err;
    if (err.guess) recordFailure(lockout);
    return fail(400, err.message);
  }
}
