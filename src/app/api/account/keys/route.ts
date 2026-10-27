import { NextRequest, NextResponse } from "next/server";
import { accountKeys, createKey, deleteKey, ensureAccount, getKey, ownKeySummary, updateKey } from "@/lib/api-tokens";
import { checkUser, type SupabaseUser } from "@/lib/supabase";

// The signed-in user's own API keys (Bearer: their Supabase access token).
// Their keys share their account's limits and usage, which only the owner
// sets; here they can only make, rename, renew and delete keys. For the
// dashboard's own page only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

async function readName(req: NextRequest): Promise<{ name?: string; rotate?: boolean }> {
  try {
    const body = (await req.json()) as { name?: unknown; rotate?: unknown };
    return {
      ...(typeof body.name === "string" ? { name: body.name.trim().slice(0, 100) || "untitled" } : {}),
      ...(body.rotate === true ? { rotate: true } : {}),
    };
  } catch {
    return {};
  }
}

// The key `?id=`, if it's this user's.
async function ownKey(req: NextRequest, user: SupabaseUser) {
  const id = req.nextUrl.searchParams.get("id");
  const key = id ? await getKey(id) : null;
  return key && key.userId === user.id ? key : null;
}

// POST {name} → a new key, sent back once in `token`.
export async function POST(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  const account = await ensureAccount(who.user);
  // A waiting account can make keys; they work once it's activated.
  if (account.disabled) return fail(403, "Your account is turned off, so it can't make keys.");
  const keys = await accountKeys(who.user.id);
  if (keys.length >= account.maxKeys) {
    return fail(403, `You can have up to ${account.maxKeys} keys. Delete one to make another.`);
  }
  const { name } = await readName(req);
  const { key, secret } = await createKey({ name: name ?? "untitled" }, who.user.id);
  return NextResponse.json({ key: ownKeySummary(key), token: secret }, { headers: NO_STORE });
}

// PATCH ?id=… {name} to rename it, or {rotate: true} for a new secret (sent
// back in `token`; the old one stops working).
export async function PATCH(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  const key = await ownKey(req, who.user);
  if (!key) return fail(404, "You have no key with that id.");
  const updated = await updateKey(key.id, await readName(req));
  if (!updated) return fail(404, "You have no key with that id.");
  return NextResponse.json(
    { key: ownKeySummary(updated.key), ...(updated.secret ? { token: updated.secret } : {}) },
    { headers: NO_STORE }
  );
}

export async function DELETE(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  const key = await ownKey(req, who.user);
  if (!key || !(await deleteKey(key.id))) return fail(404, "You have no key with that id.");
  return NextResponse.json({ deleted: key.id }, { headers: NO_STORE });
}
