import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";

// Supabase: who the people with accounts are. Only its Auth is used: people
// sign up and in with email and password on /account (and admins on the
// console too). What each account may use, its keys and its usage are in
// tokens.json (lib/api-tokens.ts), with the other access tokens, so checking
// a request never waits on Supabase.

export type SupabaseUser = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  emailConfirmed: boolean;
  admin: boolean;
};

// A failure to pass on to the caller, with its HTTP status.
export class SupabaseError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new SupabaseError(503, "Accounts aren't set up: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are needed.");
  }
  return { url: url.replace(/\/$/, ""), anonKey, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

export function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// The admins are the user ids in ADMIN_USER_IDS on the server, and nobody
// else: not a role in Supabase, which anything holding the service role key
// could set, and nothing the app can change. Making someone an admin means
// editing the server's .env.
export function isAdminId(id: string): boolean {
  return (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(id);
}

type RawUser = {
  id: string;
  email?: string;
  created_at?: string;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
};

function toUser(u: RawUser): SupabaseUser {
  return {
    id: u.id,
    email: u.email ?? "",
    createdAt: u.created_at ?? new Date(0).toISOString(),
    lastSignInAt: u.last_sign_in_at ?? null,
    emailConfirmed: Boolean(u.email_confirmed_at),
    admin: isAdminId(u.id),
  };
}

// Sign-ins already checked with Supabase, for a minute each, so a dashboard
// that polls doesn't ask every time.
const CHECK_TTL_MS = 60_000;
const checked = new Map<string, { user: SupabaseUser | null; until: number }>();

// The user a Supabase access token (a signed-in session) belongs to, or null
// when it isn't one, or has expired or been signed out.
export async function userFromToken(token: string): Promise<SupabaseUser | null> {
  const { url, anonKey } = config();
  const hash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const hit = checked.get(hash);
  if (hit && hit.until > now) return hit.user;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status >= 500) throw new SupabaseError(502, `Supabase couldn't check the sign-in (HTTP ${res.status})`);
  const user = res.ok ? toUser((await res.json()) as RawUser) : null;
  if (checked.size >= 5_000) {
    for (const [key, entry] of checked) if (entry.until <= now) checked.delete(key);
    if (checked.size >= 5_000) checked.clear();
  }
  checked.set(hash, { user, until: now + CHECK_TTL_MS });
  return user;
}

// The signed-in user behind a request to the account API: its
// `Authorization: Bearer <Supabase access token>`.
export async function checkUser(
  req: NextRequest
): Promise<{ ok: true; user: SupabaseUser } | { ok: false; status: number; error: string }> {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, error: "Sign in first." };
  try {
    const user = await userFromToken(token);
    return user ? { ok: true, user } : { ok: false, status: 401, error: "Your sign-in has ended: sign in again." };
  } catch (err) {
    const status = err instanceof SupabaseError ? err.status : 502;
    return { ok: false, status, error: err instanceof Error ? err.message : "Couldn't check the sign-in" };
  }
}

// ---------------------------------------------------------------------------
// Admin: the service role key, server-side only
// ---------------------------------------------------------------------------

async function adminCall(path: string, init?: RequestInit): Promise<unknown> {
  const { url, serviceKey } = config();
  if (!serviceKey) throw new SupabaseError(503, "SUPABASE_SERVICE_ROLE_KEY isn't set, so users can't be managed.");
  const res = await fetch(`${url}/auth/v1/admin${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 404) throw new SupabaseError(404, "No such user");
  if (!res.ok) {
    const why = data?.msg ?? data?.message ?? data?.error_description ?? data?.error ?? `HTTP ${res.status}`;
    throw new SupabaseError(502, `Supabase: ${String(why)}`);
  }
  return data;
}

const PAGE_SIZE = 200;

export async function listUsers(): Promise<SupabaseUser[]> {
  const users: SupabaseUser[] = [];
  for (let page = 1; ; page++) {
    const data = (await adminCall(`/users?page=${page}&per_page=${PAGE_SIZE}`)) as { users?: RawUser[] };
    const batch = data.users ?? [];
    users.push(...batch.map(toUser));
    if (batch.length < PAGE_SIZE) return users;
  }
}

export async function getUser(id: string): Promise<SupabaseUser | null> {
  try {
    return toUser((await adminCall(`/users/${encodeURIComponent(id)}`)) as RawUser);
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 404) return null;
    throw err;
  }
}

// Confirm an email address the user can't (when Supabase's emails don't arrive).
export async function confirmEmail(id: string): Promise<SupabaseUser> {
  return toUser(
    (await adminCall(`/users/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ email_confirm: true }),
    })) as RawUser
  );
}
