import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_IDS } from "@/lib/ai-providers";
import {
  accountKeys,
  getAccount,
  KeyChangeError,
  listAccounts,
  monthUsage,
  ownKeySummary,
  parseChanges,
  summarizeAccount,
  updateAccount,
  usageMonths,
} from "@/lib/api-tokens";
import { checkAccess, publicOrigin, refusal } from "@/lib/auth";
import { LOCAL_AGENT_PROVIDER_IDS } from "@/lib/local-agent";
import { confirmEmail, getUser, listUsers, supabaseConfigured, SupabaseError } from "@/lib/supabase";
import { todayUTC } from "@/lib/usage-ledger";

// Owner-only: the people who signed up (Supabase Auth), each with their
// account's plan, keys and usage. The Users page of the console.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const KNOWN_PROVIDERS = [...PROVIDER_IDS, ...LOCAL_AGENT_PROVIDER_IDS];

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: CORS_HEADERS });
}

function failure(err: unknown) {
  if (err instanceof KeyChangeError) return fail(400, err.message);
  if (err instanceof SupabaseError) return fail(err.status, err.message);
  return fail(500, err instanceof Error ? err.message : String(err));
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/users → every user, newest first, with their account (null until
// they first sign in to their dashboard, or you change it) and `publicOrigin`.
// GET /api/users?id=…&month=2026-10 → one user, with their keys and their
// account's use that month by day and model.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  if (!supabaseConfigured()) {
    return fail(503, "Accounts aren't set up: set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.");
  }
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      const [users, accounts] = await Promise.all([listUsers(), listAccounts()]);
      const byId = new Map(accounts.map((a) => [a.userId, a]));
      return NextResponse.json(
        {
          users: users
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((u) => {
              const account = byId.get(u.id);
              return { ...u, account: account ? summarizeAccount(account) : null };
            }),
          publicOrigin: publicOrigin(),
        },
        { headers: CORS_HEADERS }
      );
    }

    const user = await getUser(id);
    if (!user) return fail(404, `No user with id "${id}"`);
    const month = req.nextUrl.searchParams.get("month") ?? todayUTC().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(400, "`month` must be a year and month, like 2026-10");
    const account = await getAccount(id);
    return NextResponse.json(
      {
        user,
        account: account ? summarizeAccount(account) : null,
        keys: (await accountKeys(id)).map(ownKeySummary),
        usage: account ? monthUsage(account, month) : null,
        months: account ? usageMonths(account) : [month],
      },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return failure(err);
  }
}

// PATCH /api/users?id=… with the account's plan, like a key's on
// /api/tokens (limits, expiresAt, providers, agentTools, disabled, note,
// addTokens, addRequests, extendDays), and `activate`, `maxKeys`; or, in
// Supabase, `confirmEmail: true`. Who's an admin isn't changed here: it's
// ADMIN_USER_IDS in the server's .env.
export async function PATCH(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Provide the user id as ?id=");
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { admin, confirmEmail: confirm, ...rest } = body;
    if (admin !== undefined) {
      return fail(403, "Admins can't be made here: they're the user ids in ADMIN_USER_IDS in the server's .env.");
    }
    if (confirm !== undefined && confirm !== true) return fail(400, "`confirmEmail` can only be true");
    const changes = parseChanges(rest, KNOWN_PROVIDERS);

    let user = await getUser(id);
    if (!user) return fail(404, `No user with id "${id}"`);
    if (confirm) user = await confirmEmail(id);
    const account = Object.keys(changes).length ? await updateAccount(user, changes) : await getAccount(id);
    return NextResponse.json(
      { user, account: account ? summarizeAccount(account) : null },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return failure(err);
  }
}
