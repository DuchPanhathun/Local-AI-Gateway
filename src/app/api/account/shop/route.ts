import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_PACKS,
  ordersOf,
  paymentsStatus,
  PREDEFINED_DEPOSIT_AMOUNTS,
  pricing,
  readShop,
  summarizePack,
} from "@/lib/shop";
import { checkUser } from "@/lib/supabase";

// GET /api/account/shop → for the signed-in user (Bearer: their Supabase
// access token): the packs on sale, with their market price, predefined deposits,
// whether payments are set up, and their own orders. For the dashboard's own page
// only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const who = await checkUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status, headers: NO_STORE });
  const shop = await readShop();
  const packMap = new Map<string, (typeof shop.packs)[number]>();
  for (const p of DEFAULT_PACKS) packMap.set(p.id, p);
  for (const p of shop.packs) packMap.set(p.id, p);
  const packs = Array.from(packMap.values());
  return NextResponse.json(
    {
      packs: packs
        .filter((p) => p.active && pricing(p, shop.market).withinLimit)
        .map((p) => summarizePack(p, shop.market)),
      predefinedDeposits: PREDEFINED_DEPOSIT_AMOUNTS,
      deposits: PREDEFINED_DEPOSIT_AMOUNTS,
      payments: paymentsStatus(),
      orders: await ordersOf(who.user.id),
    },
    { headers: NO_STORE }
  );
}
