import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_IDS } from "@/lib/ai-providers";
import { checkAccess, publicOrigin, refusal } from "@/lib/auth";
import { LOCAL_AGENT_PROVIDER_IDS } from "@/lib/local-agent";
import {
  createCodes,
  deleteCode,
  listCodes,
  parseNewCodes,
  RedeemError,
  summarizeCode,
  updateCode,
} from "@/lib/redeem-codes";

// Owner-only: making and managing redeem codes. Their holders redeem them on
// /account (POST /api/account/redeem).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const KNOWN_PROVIDERS = [...PROVIDER_IDS, ...LOCAL_AGENT_PROVIDER_IDS];

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: CORS_HEADERS });
}

function failure(err: unknown) {
  if (err instanceof RedeemError) return fail(400, err.message);
  return fail(500, `Couldn't save the codes: ${err instanceof Error ? err.message : String(err)}`);
}

async function requireOwner(req: NextRequest): Promise<Response | null> {
  const access = await checkAccess(req, "owner");
  return access.ok ? null : refusal(access, CORS_HEADERS);
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/codes → every code, newest first, with its status, what it gives
// and who has used it, and `redeemUrl`, where people redeem them.
export async function GET(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const now = Date.now();
  return NextResponse.json(
    {
      codes: (await listCodes()).map((c) => summarizeCode(c, now)),
      redeemUrl: `${publicOrigin() ?? req.nextUrl.origin}/account`,
    },
    { headers: CORS_HEADERS }
  );
}

// POST /api/codes → make `count` codes (default 1). A plan code:
// {"kind": "plan", "limits": {...}, "providers", "agentTools", "maxKeys",
// "days"}. A top-up code: {"kind": "topup", "addTokens", "addRequests",
// "addDays"}. Either: "maxUses" (default 1), "expiresAt", "note", and "code"
// for your own text (one code only).
export async function POST(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    const made = await createCodes(parseNewCodes(body, KNOWN_PROVIDERS));
    return NextResponse.json({ codes: made.map((c) => summarizeCode(c)) }, { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}

// PATCH /api/codes?id=… {"disabled": true|false, "note": "…"}
export async function PATCH(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Provide the code id as ?id=");
  const body = (await req.json().catch(() => ({}))) as { disabled?: unknown; note?: unknown };
  if (body.disabled !== undefined && typeof body.disabled !== "boolean") return fail(400, "`disabled` must be true or false");
  if (body.note !== undefined && typeof body.note !== "string") return fail(400, "`note` must be a string");
  try {
    const code = await updateCode(id, {
      ...(typeof body.disabled === "boolean" ? { disabled: body.disabled } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
    });
    if (!code) return fail(404, `No code with id "${id}"`);
    return NextResponse.json(summarizeCode(code), { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}

// DELETE /api/codes?id=… — what a used code gave stays.
export async function DELETE(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Provide the code id as ?id=");
  try {
    if (!(await deleteCode(id))) return fail(404, `No code with id "${id}"`);
    return NextResponse.json({ deleted: id }, { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}
