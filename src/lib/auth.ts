// Who's calling, for every API route: the owner (APP_API_KEY, or the
// console's sign-in cookie) or someone with an access token, held to that
// key's limits, expiry and providers (lib/api-tokens.ts). Made to face the
// internet: keys are compared in constant time, an address that keeps sending
// wrong keys is locked out for a while, and requests that come in through the
// public door (deploy/public-door.mjs marks them x-thun-public) are refused
// outright unless APP_API_KEY is set.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { admit, allowanceOf, findKey, type ApiToken } from "./api-tokens";
import { isAdminId } from "./supabase";

export type Access =
  | { ok: true; who: "owner" }
  | { ok: true; who: "token"; key: ApiToken }
  | { ok: false; status: 401 | 403 | 429 | 503; error: string; headers?: Record<string, string> };

// "owner": APP_API_KEY or the console's cookie. "app": that, or an access
// token that's on, unexpired and within its limits. "self": that, or any
// access token, even one that's off, expired or used up (for GET /api/me,
// so its holder can see why).
export type Need = "owner" | "app" | "self";

export function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// From the internet, through Vercel and the public door. A caller on the
// tailnet or this machine who sends the header only makes things stricter
// for itself.
export function fromPublicDoor(req: NextRequest): boolean {
  return req.headers.get("x-thun-public") === "1";
}

// Whose wrong keys these are: the visitor's address, which the door sets
// from Vercel's (and nobody else can, since the door checks Vercel's
// secret), or else the tailnet user, or this machine.
function clientOf(req: NextRequest): string {
  if (fromPublicDoor(req)) return `ip:${req.headers.get("x-real-ip") || "unknown"}`;
  const login = req.headers.get("tailscale-user-login");
  return login ? `tailnet:${login}` : "private";
}

// ---------------------------------------------------------------------------
// Lockout: 10 wrong keys in 10 minutes from one place, and it's refused for
// 15 minutes. Kept in memory: a restart forgives.
// ---------------------------------------------------------------------------

export const MAX_FAILURES = 10;
const WINDOW_MS = 10 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_TRACKED = 10_000;

const failures = new Map<string, { times: number[]; lockedUntil: number }>();

export function lockedFor(client: string, now = Date.now()): number {
  const entry = failures.get(client);
  return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
}

export function recordFailure(client: string, now = Date.now()): void {
  if (failures.size >= MAX_TRACKED && !failures.has(client)) {
    for (const [key, entry] of failures) {
      if (entry.lockedUntil <= now && (entry.times.at(-1) ?? 0) < now - WINDOW_MS) failures.delete(key);
    }
    if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value!); // the oldest
  }
  const entry = failures.get(client) ?? { times: [], lockedUntil: 0 };
  entry.times = [...entry.times.filter((t) => t > now - WINDOW_MS), now];
  if (entry.times.length >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
    entry.times = [];
  }
  failures.set(client, entry);
}

export function recordSuccess(client: string): void {
  failures.delete(client);
}

export function resetLockouts(): void {
  failures.clear();
}

function lockedOut(ms: number): Access {
  const seconds = Math.ceil(ms / 1000);
  return {
    ok: false,
    status: 429,
    error: `Too many wrong keys from here: try again in ${Math.ceil(seconds / 60)} minutes.`,
    headers: { "Retry-After": String(seconds) },
  };
}

// ---------------------------------------------------------------------------
// The console's sign-in: a cookie the page's scripts can't read, signed with
// a key derived from APP_API_KEY (so a new APP_API_KEY signs everyone out).
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "thun_murex_session";
export const SESSION_SECONDS = 7 * 24 * 3600;

const sign = (appKey: string, payload: string) =>
  createHmac("sha256", createHmac("sha256", appKey).update("thun-murex console session v1").digest())
    .update(payload)
    .digest("base64url");

// The owner key's session is "v1.<expiry>". An admin's account's is
// "v2.<expiry>.<user id>", good only while that id is in ADMIN_USER_IDS:
// taking someone off the list ends their console access at once.
export function makeSession(appKey: string, now = Date.now(), seconds = SESSION_SECONDS, userId?: string): string {
  const expiry = Math.floor(now / 1000) + seconds;
  const payload = userId ? `v2.${expiry}.${userId}` : `v1.${expiry}`;
  return `${payload}.${sign(appKey, payload)}`;
}

export function validSession(value: string | undefined, appKey: string, now = Date.now()): boolean {
  const m = /^(v1\.(\d+)|v2\.(\d+)\.([0-9a-f-]{36}))\.([\w-]+)$/.exec(value ?? "");
  if (!m || Number(m[2] ?? m[3]) * 1000 <= now) return false;
  if (!sameSecret(m[5], sign(appKey, m[1]))) return false;
  return m[4] === undefined || isAdminId(m[4]);
}

// Set-Cookie for the sign-in (or, with no value, for signing out).
export function sessionCookie(req: NextRequest, value: string | null, seconds = SESSION_SECONDS): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && req.headers.get("x-forwarded-proto") !== "https";
  return [
    `${SESSION_COOKIE}=${value ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${value ? seconds : 0}`,
    ...(local ? [] : ["Secure"]),
  ].join("; ");
}

// A request that changes something, signed in by cookie, has to come from
// the console's own page. (SameSite=Strict already keeps the cookie off
// other sites' requests; this is the second lock.) Browsers say where a
// request comes from in Sec-Fetch-Site, which no proxy rewrites. The host
// headers can't be compared with Origin on the public side: Tailscale Funnel
// replaces them with its own name. So Origin is only the fallback, for
// browsers too old to send Sec-Fetch-Site, with the public addresses in
// PUBLIC_ORIGINS ("https://thun-murex.duchpanhathun.com").
export function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return true; // not a browser: it sends no cookie by itself
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const publicOrigins = (process.env.PUBLIC_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return [req.headers.get("x-forwarded-host"), req.headers.get("host")].includes(host) || publicOrigins.includes(origin);
}

const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The address to give key holders: the first of PUBLIC_ORIGINS.
export function publicOrigin(): string | null {
  return (process.env.PUBLIC_ORIGINS ?? "").split(",").map((o) => o.trim()).find(Boolean) ?? null;
}

// ---------------------------------------------------------------------------

export async function checkAccess(req: NextRequest, need: Need): Promise<Access> {
  const appKey = process.env.APP_API_KEY;
  if (!appKey) {
    return fromPublicDoor(req)
      ? { ok: false, status: 503, error: "This gateway has no APP_API_KEY, so it takes no requests from the internet." }
      : { ok: true, who: "owner" }; // private and unconfigured: open, as before
  }
  const client = clientOf(req);
  const wait = lockedFor(client);
  if (wait) return lockedOut(wait);

  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  if (bearer) {
    if (sameSecret(bearer, appKey)) {
      recordSuccess(client);
      return { ok: true, who: "owner" };
    }
    const key = need === "owner" ? null : await findKey(bearer);
    if (key) {
      const blocked = need === "app" ? admit(key) : null;
      if (blocked) {
        const headers = blocked.retryAfter ? { "Retry-After": String(blocked.retryAfter) } : undefined;
        return { ok: false, status: blocked.status, error: blocked.error, headers };
      }
      return { ok: true, who: "token", key };
    }
    recordFailure(client);
    const after = lockedFor(client);
    return after ? lockedOut(after) : { ok: false, status: 401, error: "Unauthorized" };
  }

  if (validSession(req.cookies.get(SESSION_COOKIE)?.value, appKey)) {
    if (CHANGES.has(req.method) && !sameOrigin(req)) return { ok: false, status: 403, error: "Refused: this request didn't come from the console's own page." };
    return { ok: true, who: "owner" };
  }
  return { ok: false, status: 401, error: "Unauthorized" };
}

// ---------------------------------------------------------------------------
// What an access token may do with a provider
// ---------------------------------------------------------------------------

// The local CLIs read files on this machine when they run with their tools.
// Claude Code and Codex can answer without them (no_tools); Gemini CLI and
// Antigravity can't.
const HOST_AGENTS = new Set(["claude", "codex", "gemini", "antigravity"]);
const TOOL_FREE = new Set(["claude", "codex"]);

export type KeyRule = {
  refused: string | null; // why this key can't use the provider, for a 403
  // A key without agent access: local CLIs run without their tools, in the
  // gateway's default workdir.
  sandboxed: boolean;
  caller?: string; // the key's id, which its usage is counted under
};

// `image`: for /api/image, which runs Codex with its image tool.
export function keyRule(
  access: Extract<Access, { ok: true }>,
  provider: string,
  { image = false }: { image?: boolean } = {}
): KeyRule {
  if (access.who === "owner") return { refused: null, sandboxed: false };
  const { key } = access;
  // An account's key goes by its account's providers and agent access.
  const allowance = allowanceOf(key);
  if (!allowance) return { refused: "This API key's account no longer exists.", sandboxed: true, caller: key.id };
  const hasCredit =
    "creditBalance" in allowance &&
    (((allowance as { creditBalance?: number }).creditBalance ?? (allowance as { balance?: number }).balance ?? 0) > 0);
  const { providers, agentTools } = allowance;
  if (!hasCredit && providers && !providers.includes(provider)) {
    const allowed = providers.length ? `It can use ${providers.join(", ")}.` : "It can't use any provider.";
    return { refused: `This API key can't use ${provider}. ${allowed}`, sandboxed: true, caller: key.id };
  }
  const canRunTools = agentTools || hasCredit;
  if (!canRunTools && image) {
    return { refused: "This API key can't generate images: that runs Codex on the server with its tools.", sandboxed: true, caller: key.id };
  }
  if (!canRunTools && HOST_AGENTS.has(provider) && !TOOL_FREE.has(provider)) {
    return {
      refused: `This API key can't use ${provider}: it only runs with its tools, which read files on the server.`,
      sandboxed: true,
      caller: key.id,
    };
  }
  return { refused: null, sandboxed: !canRunTools, caller: key.id };
}

// Sign-in with the owner key, for /api/session: the lockout counts here too.
export function checkSignIn(req: NextRequest, key: string): Access {
  const appKey = process.env.APP_API_KEY;
  if (!appKey) return { ok: false, status: 503, error: "Set APP_API_KEY on the server first: the sign-in is checked against it." };
  if (!sameOrigin(req)) return { ok: false, status: 403, error: "Refused: sign in from the console's own page." };
  const client = clientOf(req);
  const wait = lockedFor(client);
  if (wait) return lockedOut(wait);
  if (key && sameSecret(key, appKey)) {
    recordSuccess(client);
    return { ok: true, who: "owner" };
  }
  recordFailure(client);
  const after = lockedFor(client);
  return after ? lockedOut(after) : { ok: false, status: 401, error: "Wrong key: check APP_API_KEY and try again." };
}

// The refusal, as the JSON reply a route sends (with its own CORS headers).
export function refusal(access: Extract<Access, { ok: false }>, headers: Record<string, string> = {}): Response {
  return Response.json({ error: access.error }, { status: access.status, headers: { ...headers, ...access.headers } });
}
