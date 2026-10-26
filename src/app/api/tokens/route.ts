import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_IDS } from "@/lib/ai-providers";
import {
  createKey,
  deleteKey,
  getKey,
  KeyChangeError,
  keyMonth,
  listKeys,
  parseChanges,
  summarize,
  updateKey,
} from "@/lib/api-tokens";
import { LOCAL_AGENT_PROVIDER_IDS } from "@/lib/local-agent";
import { todayUTC } from "@/lib/usage-ledger";
import { checkAccess, refusal } from "@/lib/auth";

// Owner-only: making, changing and deleting access tokens, and reading their
// usage, needs APP_API_KEY or the console's sign-in. A token can never manage
// tokens, its own included (its holder reads it at GET /api/me).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const KNOWN_PROVIDERS = [...PROVIDER_IDS, ...LOCAL_AGENT_PROVIDER_IDS];

async function requireOwner(req: NextRequest): Promise<Response | null> {
  const access = await checkAccess(req, "owner");
  return access.ok ? null : refusal(access, CORS_HEADERS);
}

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: CORS_HEADERS });
}

// A bad change is the caller's (400); anything else is the server failing
// to save (500).
function failure(err: unknown) {
  if (err instanceof KeyChangeError) return fail(400, err.message);
  return fail(500, `Couldn't save the access tokens: ${err instanceof Error ? err.message : String(err)}`);
}

async function readBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {}; // no body: every setting keeps its default
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/tokens → every key with its status and the current period's usage,
// plus `publicOrigin`, the address to give key holders.
// GET /api/tokens?id=…&month=2026-10 → one key, with its usage that month
// (default: this one) by day and model, and the months it has usage in.
export async function GET(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    const tokens = (await listKeys()).map((key) => summarize(key));
    const publicOrigin = (process.env.PUBLIC_ORIGINS ?? "").split(",").map((o) => o.trim()).find(Boolean) ?? null;
    return NextResponse.json({ tokens, publicOrigin }, { headers: CORS_HEADERS });
  }

  const key = await getKey(id);
  if (!key) return fail(404, `No token with id "${id}"`);
  const month = req.nextUrl.searchParams.get("month") ?? todayUTC().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(400, "`month` must be a year and month, like 2026-10");
  const months = new Set([todayUTC().slice(0, 7), ...Object.keys(key.days).map((day) => day.slice(0, 7))]);
  return NextResponse.json(
    { token: summarize(key), usage: keyMonth(key, month), months: [...months].sort().reverse() },
    { headers: CORS_HEADERS }
  );
}

// POST /api/tokens {name, note, limits, expiresAt, providers, agentTools} →
// the new key's summary, with the key itself in `token`: the only time it's
// ever sent.
export async function POST(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  try {
    const { key, secret } = await createKey(parseChanges(await readBody(req), KNOWN_PROVIDERS));
    return NextResponse.json({ ...summarize(key), token: secret }, { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}

// PATCH /api/tokens?id=… with any of POST's fields, or `addTokens`,
// `addRequests`, `extendDays`, `rotate: true` (a new key, sent back in
// `token`; the old one stops working).
export async function PATCH(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Provide the token id as ?id=");
  try {
    const updated = await updateKey(id, parseChanges(await readBody(req), KNOWN_PROVIDERS));
    if (!updated) return fail(404, `No token with id "${id}"`);
    return NextResponse.json(
      { ...summarize(updated.key), ...(updated.secret ? { token: updated.secret } : {}) },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Provide the token id as ?id=");
  try {
    if (!(await deleteKey(id))) return fail(404, `No token with id "${id}"`);
    return NextResponse.json({ revoked: id }, { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}
