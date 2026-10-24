import { NextRequest, NextResponse } from "next/server";
import { checkSignIn, makeSession, refusal, SESSION_COOKIE, sessionCookie, validSession } from "@/lib/auth";

// The console's sign-in. The owner key is checked once, here, and the browser
// gets a cookie its scripts can't read (HttpOnly, SameSite=Strict) instead of
// keeping the key. For the console's own page only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

// Signed in?
export function GET(req: NextRequest) {
  const appKey = process.env.APP_API_KEY;
  const signedIn = !!appKey && validSession(req.cookies.get(SESSION_COOKIE)?.value, appKey);
  return NextResponse.json({ signedIn }, { headers: NO_STORE });
}

// Sign in: {"key": "<APP_API_KEY>"}.
export async function POST(req: NextRequest) {
  let key = "";
  try {
    const body = (await req.json()) as { key?: unknown };
    key = typeof body.key === "string" ? body.key.trim() : "";
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400, headers: NO_STORE });
  }
  const access = checkSignIn(req, key);
  if (!access.ok) return refusal(access, NO_STORE);
  const res = NextResponse.json({ signedIn: true }, { headers: NO_STORE });
  res.headers.append("Set-Cookie", sessionCookie(req, makeSession(process.env.APP_API_KEY!)));
  return res;
}

// Sign out.
export function DELETE(req: NextRequest) {
  const res = NextResponse.json({ signedIn: false }, { headers: NO_STORE });
  res.headers.append("Set-Cookie", sessionCookie(req, null));
  return res;
}
