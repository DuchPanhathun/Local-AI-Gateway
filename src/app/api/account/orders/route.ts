import { NextRequest, NextResponse } from "next/server";
import { ensureAccount } from "@/lib/api-tokens";
import { publicOrigin } from "@/lib/auth";
import {
  cancelOrder,
  finishOrder,
  ordersOf,
  PREDEFINED_DEPOSIT_AMOUNTS,
  ShopError,
  startDepositOrder,
  startOrder,
} from "@/lib/shop";
import { checkUser } from "@/lib/supabase";

// Buying a pack or depositing credit with PayPal, for the signed-in user (Bearer: their Supabase
// access token). For the dashboard's own page only: no CORS.
//   GET → { orders, predefinedAmounts }
//   POST {"packId"} or {"amountCents"} or {"amount"} or {"depositAmount"} → {orderId, approveUrl}: send them to approveUrl
//   PATCH ?id=… {"action": "finish"} once they're back: takes the payment
//   and credits balance (or gives pack); {"action": "cancel"} if they cancelled.

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

export async function GET(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  return NextResponse.json(
    {
      orders: await ordersOf(who.user.id),
      predefinedAmounts: PREDEFINED_DEPOSIT_AMOUNTS,
    },
    { headers: NO_STORE }
  );
}

export async function POST(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return fail(who.status, who.error);
  const body = (await req.json().catch(() => ({}))) as {
    packId?: unknown;
    amountCents?: unknown;
    amountUSD?: unknown;
    amount?: unknown;
    depositAmount?: unknown;
  };

  try {
    await ensureAccount(who.user);

    // 1. Credit deposit flow
    let depositCents: number | null = null;
    if (typeof body.amountCents === "number") {
      depositCents = Math.round(body.amountCents);
    } else if (typeof body.amountUSD === "number") {
      depositCents = Math.round(body.amountUSD * 100);
    } else if (typeof body.amount === "number") {
      depositCents = Math.round(body.amount * 100);
    } else if (typeof body.depositAmount === "number") {
      depositCents = Math.round(body.depositAmount * 100);
    }

    if (depositCents !== null) {
      if (depositCents < 100 || depositCents > 100_000) {
        return fail(400, "Deposit amount must be between $1.00 (100 cents) and $1,000.00 (100,000 cents).");
      }
      return NextResponse.json(
        await startDepositOrder(who.user, depositCents, returnBase(req)),
        { headers: NO_STORE }
      );
    }

    // 2. Token pack flow
    if (typeof body.packId === "string" && body.packId.trim()) {
      return NextResponse.json(
        await startOrder(who.user, body.packId.trim(), returnBase(req)),
        { headers: NO_STORE }
      );
    }

    return fail(
      400,
      "Provide either a token pack ID (`packId`) or a deposit amount (`amountCents` or `amount` in USD)."
    );
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
          type: order.type ?? "pack",
          applied: order.applied,
          code: order.applied ? null : order.code,
          packName: order.packName,
          priceCents: order.priceCents,
          creditCents: order.creditCents ?? (order.type === "deposit" ? order.priceCents : null),
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
