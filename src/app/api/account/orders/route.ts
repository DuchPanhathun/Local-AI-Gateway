import { NextRequest, NextResponse } from "next/server";
import { ensureAccount } from "@/lib/api-tokens";
import { publicOrigin } from "@/lib/auth";
import { cancelOrder, finishOrder, ShopError, startOrder } from "@/lib/shop";
import { checkUser } from "@/lib/supabase";

// Buying a pack with PayPal, for the signed-in user (Bearer: their Supabase
// access token). For the dashboard's own page only: no CORS.
//   POST {"packId"} → {orderId, approveUrl}: send them to approveUrl
//   PATCH ?id=… {"action": "finish"} once they're back: takes the payment
//   and gives them the pack; {"action": "cancel"} if they cancelled.

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function failure(err: unknown) {
  if (err instanceof ShopError) return fail(err.status, err.message);
  return fail(500, err instanceof Error ? err.message : String(err));
}

// Where PayPal sends them back: the address they're using (as their browser
// says), else the public one.
function returnBase(req: NextRequest): string {
  const origin = req.headers.get("origin");
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  return publicOrigin() ?? req.nextUrl.origin;
}

export async function POST(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  const body = (await req.json().catch(() => ({}))) as { packId?: unknown };
  if (typeof body.packId !== "string") return fail(400, "Say which pack: `packId`");
  try {
    await ensureAccount(who.user);
    return NextResponse.json(await startOrder(who.user, body.packId, returnBase(req)), { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

export async function PATCH(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Provide the order id as ?id=");
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  try {
    if (body.action === "finish") {
      const order = await finishOrder(who.user, id);
      return NextResponse.json(
        {
          status: order.status,
          applied: order.applied,
          code: order.applied ? null : order.code,
          packName: order.packName,
        },
        { headers: NO_STORE }
      );
    }
    if (body.action === "cancel") {
      const order = await cancelOrder(who.user, id);
      return NextResponse.json({ status: order.status }, { headers: NO_STORE });
    }
    return fail(400, "`action` must be finish or cancel");
  } catch (err) {
    return failure(err);
  }
}
