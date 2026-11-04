import { NextRequest, NextResponse } from "next/server";
import {
  checkSignIn,
  makeSession,
  refusal,
  sameOrigin,
  SESSION_COOKIE,
  sessionCookie,
  validSession,
} from "@/lib/auth";
import { SupabaseError, userFromToken } from "@/lib/supabase";

// The console's sign-in. The owner key, or an admin's account, is checked
// once, here, and the browser gets a cookie its scripts can't read (HttpOnly,
// SameSite=Strict) instead of keeping the key. For the console's own page
// only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

// An admin signed in with their account gets 12 hours, not the owner key's
// week. Their session names them, so it ends as soon as they're taken out
// of ADMIN_USER_IDS.
const ACCOUNT_SESSION_SECONDS = 12 * 3600;

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

// Signed in? And `local`: this is the one-person edition that `npx
// local-ai-gateway` runs on someone's own computer (LOCAL_EDITION=1), which
// has no accounts, shop or access for other people, so the console leaves
// those pages out.
export function GET(req: NextRequest) {
  const appKey = process.env.APP_API_KEY;
  const signedIn = !!appKey && validSession(req.cookies.get(SESSION_COOKIE)?.value, appKey);
  return NextResponse.json({ signedIn, local: process.env.LOCAL_EDITION === "1" }, { headers: NO_STORE });
}

// Sign in: {"key": "<APP_API_KEY>"}, or {"accessToken": "<a Supabase
// session's access token>"} of an account in ADMIN_USER_IDS. Any other
// account gets 403 with `account: true`: its dashboard is /account.
export async function POST(req: NextRequest) {
  let body: { key?: unknown; accessToken?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, "Request body must be valid JSON");
  }
  if (typeof body.accessToken === "string" && body.accessToken) {
    return signInWithAccount(req, body.accessToken);
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const access = checkSignIn(req, key);
  if (!access.ok) return refusal(access, NO_STORE);
  const res = NextResponse.json({ signedIn: true }, { headers: NO_STORE });
  res.headers.append("Set-Cookie", sessionCookie(req, makeSession(process.env.APP_API_KEY!)));
  return res;
}

async function signInWithAccount(req: NextRequest, token: string) {
  const appKey = process.env.APP_API_KEY;
  if (!appKey) return fail(503, "Set APP_API_KEY on the server first: console sign-ins are signed with it.");
  if (!sameOrigin(req)) return fail(403, "Refused: sign in from the console's own page.");
  let user;
  try {
    user = await userFromToken(token);
  } catch (err) {
    return fail(err instanceof SupabaseError ? err.status : 502, err instanceof Error ? err.message : "Couldn't check the sign-in");
  }
  if (!user) return fail(401, "Your sign-in has ended: sign in again.");
  if (!user.admin) return fail(403, "This account isn't an admin. Its dashboard is at /account.", { account: true });
  const res = NextResponse.json({ signedIn: true }, { headers: NO_STORE });
  res.headers.append(
    "Set-Cookie",
    sessionCookie(req, makeSession(appKey, Date.now(), ACCOUNT_SESSION_SECONDS, user.id), ACCOUNT_SESSION_SECONDS)
  );
  return res;
}

// Sign out.
export function DELETE(req: NextRequest) {
  const res = NextResponse.json({ signedIn: false }, { headers: NO_STORE });
  res.headers.append("Set-Cookie", sessionCookie(req, null));
  return res;
}
