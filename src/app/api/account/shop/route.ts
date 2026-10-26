import { NextRequest, NextResponse } from "next/server";
import { ordersOf, paymentsStatus, pricing, readShop, summarizePack } from "@/lib/shop";
import { checkUser } from "@/lib/supabase";

// GET /api/account/shop → for the signed-in user (Bearer: their Supabase
// access token): the packs on sale, with their market price, whether
// payments are set up, and their own orders. For the dashboard's own page
// only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status, headers: NO_STORE });
  const shop = await readShop();
  return NextResponse.json(
    {
      packs: shop.packs
        .filter((p) => p.active && pricing(p, shop.market).withinLimit)
        .sort((a, b) => a.priceCents - b.priceCents)
        .map((p) => summarizePack(p, shop.market)),
      payments: paymentsStatus(),
      orders: await ordersOf(who.user.id),
    },
    { headers: NO_STORE }
  );
}
