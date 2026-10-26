import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_IDS } from "@/lib/ai-providers";
import { checkAccess, refusal } from "@/lib/auth";
import { LOCAL_AGENT_PROVIDER_IDS } from "@/lib/local-agent";
import {
  blended,
  createPack,
  deletePack,
  MAX_SHARE,
  parsePack,
  paymentsStatus,
  readShop,
  ShopError,
  summarizePack,
  updateMarket,
  updatePack,
} from "@/lib/shop";

// Owner-only: the shop's packs, the market prices they're held to, and every
// order. People buy on /account (/api/account/shop, /api/account/orders).
//   GET → {market, packs, orders, payments, maxShare}
//   POST {name, price, tokens, providers, days, …} → a new pack
//   PATCH ?pack=… {…} → a pack changed; PATCH {"market": {provider: {input, output}}}
//   DELETE ?pack=…

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
  if (err instanceof ShopError) return fail(err.status, err.message);
  return fail(500, `Couldn't save the shop: ${err instanceof Error ? err.message : String(err)}`);
}

async function requireOwner(req: NextRequest): Promise<Response | null> {
  const access = await checkAccess(req, "owner");
  return access.ok ? null : refusal(access, CORS_HEADERS);
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const shop = await readShop();
  return NextResponse.json(
    {
      market: Object.fromEntries(Object.entries(shop.market).map(([id, p]) => [id, { ...p, blended: blended(p) }])),
      packs: shop.packs.map((p) => summarizePack(p, shop.market)),
      orders: [...shop.orders].reverse(),
      payments: paymentsStatus(),
      maxShare: MAX_SHARE,
    },
    { headers: CORS_HEADERS }
  );
}

export async function POST(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  try {
    const shop = await readShop();
    const pack = await createPack(parsePack(await req.json().catch(() => null), KNOWN_PROVIDERS, shop.market));
    return NextResponse.json(summarizePack(pack, shop.market), { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}

export async function PATCH(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const id = req.nextUrl.searchParams.get("pack");
    if (!id) {
      if (!body?.market) return fail(400, "Send {\"market\": {…}}, or ?pack= to change a pack");
      return NextResponse.json({ market: await updateMarket(body.market) }, { headers: CORS_HEADERS });
    }
    const shop = await readShop();
    const pack = shop.packs.find((p) => p.id === id);
    if (!pack) return fail(404, `No pack with id "${id}"`);
    // Taking a pack off sale is always allowed; anything else is held to the price limit.
    const changes =
      body && Object.keys(body).length === 1 && body.active === false
        ? { ...pack, active: false }
        : parsePack(body, KNOWN_PROVIDERS, shop.market, pack);
    const updated = await updatePack(id, changes);
    return NextResponse.json(summarizePack(updated!, shop.market), { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireOwner(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("pack");
  if (!id) return fail(400, "Provide the pack id as ?pack=");
  try {
    if (!(await deletePack(id))) return fail(404, `No pack with id "${id}"`);
    return NextResponse.json({ deleted: id }, { headers: CORS_HEADERS });
  } catch (err) {
    return failure(err);
  }
}
