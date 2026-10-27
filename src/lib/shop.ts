import { randomUUID } from "node:crypto";
import { changeTokenFile, readTokenFile, usedInPeriod, type Account, type TokenFile } from "./api-tokens";
import { describeCode, issueCodeIn, RedeemError, redeemIn, sameOrFewer, type Grant } from "./redeem-codes";
import { DEFAULT_PACKS, type TokenPack } from "./token-packs";

export { DEFAULT_PACKS, type TokenPack };

// The shop on /account: prepaid packs of tokens that people buy with PayPal.
// A pack's price is at most a tenth of what its tokens cost at the market
// price of the cheapest provider it can be used on, so it's at least 10 times
// cheaper however its tokens are spent. A paid order becomes a single-use redeem code that's
// redeemed on the buyer's account at once (or, if it can't be yet, kept for
// them to redeem), so a payment is never lost. Packs, market prices and
// orders are kept in tokens.json with the accounts and codes.
//
// PayPal: the Orders API (v2) with a redirect, so no PayPal script runs on
// our pages. We make the order, the buyer approves it on PayPal and comes
// back to /account, and we capture it then. An order approved but never
// captured takes no money.

export const MAX_SHARE = 0.1; // of the market value: "at least 10 times cheaper"
const IN_PER_OUT = 3; // input tokens for each output token, for a blended price (3:1, as price trackers use)
export const CURRENCY = "USD"; // market prices are in US dollars

// USD per million tokens.
export type MarketPrice = { model: string; input: number; output: number; source: string };

// Public list prices as of October 2026 for the model each provider answers
// with by default, from price trackers that cite the providers' pages. The
// owner can change them on the console's Shop page.
export const DEFAULT_MARKET: Record<string, MarketPrice> = {
  "sea-lion": { model: "Qwen3.5 27B on OpenRouter (nearest to Qwen-SEA-LION v4.5 27B)", input: 0.3, output: 2.4, source: "https://www.getmaxim.ai/bifrost/llm-cost-calculator/provider/openrouter/model/qwen3.5-27b" },
  cerebras: { model: "Qwen3.8 27B on Cerebras", input: 0.99, output: 1.49, source: "https://computeprices.com/providers/cerebras/models/qwen3-8-27b" },
  groq: { model: "gpt-oss-120b on Groq", input: 0.15, output: 0.6, source: "https://www.morphllm.com/groq-pricing" },
  claude: { model: "Claude Sonnet 4.6", input: 3, output: 15, source: "https://metacto.com/blogs/anthropic-api-pricing-a-full-breakdown-of-costs-and-integration" },
  codex: { model: "GPT-5 Codex", input: 1.25, output: 10, source: "https://anotherwrapper.com/llm-pricing/gpt-5-codex-2025-09-15" },
  gemini: { model: "Gemini 3 Pro", input: 2, output: 12, source: "https://anotherwrapper.com/llm-pricing/gemini-3-pro-preview" },
  antigravity: { model: "Gemini 3 Pro", input: 2, output: 12, source: "https://anotherwrapper.com/llm-pricing/gemini-3-pro-preview" },
  chatgpt: { model: "GPT-5", input: 1.25, output: 10, source: "https://anotherwrapper.com/llm-pricing/gpt-5-codex-2025-09-15" },
  grok: { model: "Grok 4.1 Fast (Grok's fast mode)", input: 0.2, output: 0.5, source: "https://www.morphllm.com/grok-api-pricing" },
  mimo: { model: "MiMo-V2.6 Pro", input: 0.435, output: 0.87, source: "https://www.eesel.ai/blog/xiaomi-mimo-v2-6-pricing" },
};

export type Pack = {
  id: string;
  name: string;
  description: string;
  tokens: number;
  providers: string[] | null; // null: every provider
  agentTools: boolean;
  maxKeys: number;
  perMinute: number | null;
  days: number | null; // how long it lasts; null: no end
  priceCents: number;
  active: boolean; // on sale
  createdAt: string;
};

export type OrderStatus = "created" | "pending" | "paid" | "cancelled";
export type OrderType = "pack" | "deposit";

export type PredefinedDeposit = {
  amountUSD: number;
  amountCents: number;
  label: string;
};

export const PREDEFINED_DEPOSIT_AMOUNTS: PredefinedDeposit[] = [
  { amountUSD: 5, amountCents: 500, label: "$5" },
  { amountUSD: 10, amountCents: 1000, label: "$10" },
  { amountUSD: 25, amountCents: 2500, label: "$25" },
  { amountUSD: 50, amountCents: 5000, label: "$50" },
  { amountUSD: 100, amountCents: 10000, label: "$100" },
];

export type Order = {
  id: string; // PayPal's
  type?: OrderType;
  packId: string;
  packName: string;
  grant: Grant; // the pack as it was ordered
  priceCents: number;
  creditCents?: number;
  currency: string;
  userId: string;
  email: string;
  status: OrderStatus; // "pending": PayPal took it, but the money hasn't cleared
  createdAt: string;
  paidAt: string | null;
  captureId: string | null;
  code: string | null; // the redeem code it became
  applied: string | null; // what redeeming it gave; null while it waits to be redeemed
};

export type Shop = { market: Record<string, MarketPrice>; packs: Pack[]; orders: Order[] };

// A failure to pass on, with its HTTP status.
export class ShopError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// The shop in `file`, made (with the default market prices) the first time.
function shopOf(file: TokenFile): Shop {
  file.shop ??= { market: {}, packs: [], orders: [] };
  file.shop.market = { ...DEFAULT_MARKET, ...file.shop.market };
  file.shop.packs ??= [];
  for (const def of DEFAULT_PACKS) {
    const existingIndex = file.shop.packs.findIndex((p) => p.id === def.id);
    if (existingIndex === -1) {
      file.shop.packs.push({ ...def });
    } else {
      file.shop.packs[existingIndex] = {
        ...def,
        ...file.shop.packs[existingIndex],
        priceCents: def.priceCents,
        tokens: def.tokens,
        providers: def.providers,
      };
    }
  }
  return file.shop;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export function blended(p: MarketPrice): number {
  return (IN_PER_OUT * p.input + p.output) / (IN_PER_OUT + 1);
}

// The cheapest provider a pack's tokens can be used on, and its blended price.
function cheapest(providers: string[] | null, market: Record<string, MarketPrice>) {
  const ids = (providers ?? Object.keys(market)).filter((id) => market[id]);
  if (!ids.length) return null;
  const id = ids.reduce((a, b) => (blended(market[b]) < blended(market[a]) ? b : a));
  return { provider: id, model: market[id].model, perMillion: blended(market[id]) };
}

export type PackPricing = {
  marketCents: number | null; // what its tokens cost at the cheapest provider's market price
  maxPriceCents: number | null; // a tenth of that, rounded down
  cheapest: { provider: string; model: string; perMillion: number } | null;
  savingPercent: number | null;
  withinLimit: boolean;
};

export function pricing(pack: Pick<Pack, "tokens" | "providers" | "priceCents">, market: Record<string, MarketPrice>): PackPricing {
  const low = cheapest(pack.providers, market);
  if (!low) return { marketCents: null, maxPriceCents: null, cheapest: null, savingPercent: null, withinLimit: false };
  const marketCents = (pack.tokens / 1e6) * low.perMillion * 100;
  const maxPriceCents = Math.floor(marketCents * MAX_SHARE);
  return {
    marketCents: Math.round(marketCents * 100) / 100,
    maxPriceCents,
    cheapest: low,
    savingPercent: marketCents > 0 ? Math.round((1 - pack.priceCents / marketCents) * 100) : null,
    withinLimit: pack.priceCents >= 1 && pack.priceCents <= maxPriceCents,
  };
}

// What buying the pack gives: a prepaid plan, like a plan code's.
export function grantOf(pack: Pack): Grant {
  return {
    kind: "plan",
    plan: {
      period: "total",
      tokens: pack.tokens,
      requests: null,
      perMinute: pack.perMinute,
      providers: pack.providers,
      agentTools: pack.agentTools,
      maxKeys: pack.maxKeys,
      days: pack.days,
    },
    addTokens: null,
    addRequests: null,
    addDays: null,
  };
}

export function summarizePack(pack: Pack, market: Record<string, MarketPrice>) {
  return { ...pack, gives: describeCode(grantOf(pack)), pricing: pricing(pack, market) };
}

// ---------------------------------------------------------------------------
// The owner's side
// ---------------------------------------------------------------------------

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ShopError(400, `\`${field}\` must be a whole number from ${min.toLocaleString("en")} to ${max.toLocaleString("en")}`);
  }
  return value;
}

// A pack from a request body (the whole of it for a new one, or any of its
// fields for a change), checked, and checked against the price limit.
export function parsePack(
  body: unknown,
  knownProviders: readonly string[],
  market: Record<string, MarketPrice>,
  base?: Pack
): Omit<Pack, "id" | "createdAt"> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShopError(400, "Send a JSON object");
  const b = body as Record<string, unknown>;
  const has = (field: string) => b[field] !== undefined;
  const text = (field: string, max: number, fallback: string) => {
    if (!has(field)) return fallback;
    if (typeof b[field] !== "string") throw new ShopError(400, `\`${field}\` must be a string`);
    return (b[field] as string).trim().slice(0, max);
  };
  const name = text("name", 80, base?.name ?? "");
  if (!name) throw new ShopError(400, "Give the pack a name");
  let priceCents = base?.priceCents;
  if (has("price")) {
    if (typeof b.price !== "number" || !(b.price > 0) || b.price > 100_000) {
      throw new ShopError(400, "`price` must be an amount in US dollars, like 4.99");
    }
    priceCents = Math.round(b.price * 100);
  }
  if (priceCents === undefined) throw new ShopError(400, "Give the pack a `price` in US dollars");
  const tokens = has("tokens") ? whole(b.tokens, "tokens", 1000, 1e13) : base?.tokens;
  if (tokens === undefined) throw new ShopError(400, "Give the pack its `tokens`");
  let providers = base ? base.providers : null;
  if (has("providers")) {
    if (b.providers === null) providers = null;
    else if (Array.isArray(b.providers) && b.providers.length && b.providers.every((p) => knownProviders.includes(p as string))) {
      providers = [...new Set(b.providers as string[])];
    } else throw new ShopError(400, `\`providers\` must be null (all) or some of: ${knownProviders.join(", ")}`);
  }
  const optional = (field: string, max: number, fallback: number | null) =>
    !has(field) ? fallback : b[field] === null || b[field] === 0 ? null : whole(b[field], field, 1, max);
  if (has("agentTools") && typeof b.agentTools !== "boolean") throw new ShopError(400, "`agentTools` must be true or false");
  if (has("active") && typeof b.active !== "boolean") throw new ShopError(400, "`active` must be true or false");
  const pack = {
    name,
    description: text("description", 300, base?.description ?? ""),
    tokens,
    providers,
    agentTools: has("agentTools") ? (b.agentTools as boolean) : (base?.agentTools ?? false),
    maxKeys: has("maxKeys") ? whole(b.maxKeys, "maxKeys", 0, 100) : (base?.maxKeys ?? 5),
    perMinute: optional("perMinute", 100_000, base?.perMinute ?? null),
    days: optional("days", 3650, base?.days ?? null),
    priceCents,
    active: has("active") ? (b.active as boolean) : (base?.active ?? true),
  };
  const p = pricing(pack, market);
  if (!p.withinLimit) {
    throw new ShopError(
      400,
      p.maxPriceCents === null
        ? "None of its providers has a market price to compare with."
        : `Too dear: these tokens cost $${((p.marketCents ?? 0) / 100).toFixed(2)} at the market price of ${p.cheapest?.model}, so the pack can cost at most $${(p.maxPriceCents / 100).toFixed(2)} (a tenth).`
    );
  }
  return pack;
}

export async function readShop(): Promise<Shop> {
  return shopOf(await readTokenFile());
}

export async function createPack(pack: Omit<Pack, "id" | "createdAt">): Promise<Pack> {
  return changeTokenFile((file) => {
    const made: Pack = { ...pack, id: randomUUID().slice(0, 16).replace(/-/g, ""), createdAt: new Date().toISOString() };
    shopOf(file).packs.push(made);
    return made;
  });
}

export async function updatePack(id: string, changes: Omit<Pack, "id" | "createdAt">): Promise<Pack | null> {
  return changeTokenFile((file) => {
    const pack = shopOf(file).packs.find((p) => p.id === id);
    if (!pack) return null;
    Object.assign(pack, changes);
    return pack;
  });
}

export async function deletePack(id: string): Promise<boolean> {
  return changeTokenFile((file) => {
    const shop = shopOf(file);
    const before = shop.packs.length;
    shop.packs = shop.packs.filter((p) => p.id !== id);
    return shop.packs.length < before;
  });
}

// New market prices for some providers: {"groq": {"input": 0.15, "output": 0.6}}.
// A pack they put over the limit leaves the shop until its price is lowered.
export async function updateMarket(body: unknown): Promise<Record<string, MarketPrice>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShopError(400, "Send {provider: {input, output}}");
  const changes = body as Record<string, Record<string, unknown>>;
  return changeTokenFile((file) => {
    const shop = shopOf(file);
    for (const [id, c] of Object.entries(changes)) {
      if (!shop.market[id]) throw new ShopError(400, `No market price for "${id}"`);
      const next = { ...shop.market[id] };
      for (const field of ["input", "output"] as const) {
        if (c[field] === undefined) continue;
        if (typeof c[field] !== "number" || c[field] < 0 || c[field] > 10_000) {
          throw new ShopError(400, `${id}.${field} must be US dollars per million tokens`);
        }
        next[field] = c[field] as number;
      }
      for (const field of ["model", "source"] as const) {
        if (typeof c[field] === "string") next[field] = (c[field] as string).trim().slice(0, 200);
      }
      shop.market[id] = next;
    }
    return shop.market;
  });
}

// Why buying a pack for `providers` would throw away tokens the account has
// left, or null. What's left of a prepaid plan is kept when the pack covers
// the same providers or fewer; a pack for others would replace it.
function wouldLose(account: Account, providers: string[] | null, now = Date.now()): string | null {
  const current = account.activatedAt && !account.disabled && !(account.expiresAt && Date.parse(account.expiresAt) <= now);
  if (!current || account.limits.period !== "total" || account.limits.tokens === null) return null;
  const left = account.limits.tokens - usedInPeriod(account).tokens;
  if (left <= 0 || sameOrFewer(providers, account.providers)) return null;
  return `You still have ${left.toLocaleString("en")} tokens for other providers, which this pack would replace. Use them up first, or buy a pack for the same providers.`;
}

// ---------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------

function paypalConfig() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) return null;
  const live = process.env.PAYPAL_ENV === "live";
  return {
    clientId,
    secret,
    live,
    // PAYPAL_API_BASE: only to test against a stand-in.
    base: process.env.PAYPAL_API_BASE || (live ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com"),
  };
}

export function paymentsStatus() {
  const config = paypalConfig();
  return { configured: Boolean(config), live: Boolean(config?.live), currency: CURRENCY };
}

let accessToken: { value: string; until: number; clientId: string } | null = null;

async function paypalToken(config: NonNullable<ReturnType<typeof paypalConfig>>): Promise<string> {
  if (accessToken && accessToken.clientId === config.clientId && accessToken.until > Date.now()) return accessToken.value;
  const res = await fetch(`${config.base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!res.ok || !data?.access_token) {
    throw new ShopError(502, `PayPal refused our credentials: ${data?.error_description ?? `HTTP ${res.status}`}`);
  }
  accessToken = { value: data.access_token, until: Date.now() + ((data.expires_in ?? 600) - 60) * 1000, clientId: config.clientId };
  return accessToken.value;
}

type PayPalOrder = {
  id: string;
  status: string;
  links?: { rel: string; href: string }[];
  purchase_units?: {
    custom_id?: string;
    payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[] };
  }[];
};

async function paypal(path: string, init: { method: string; body?: unknown; requestId?: string }): Promise<{ status: number; data: Record<string, unknown> }> {
  const config = paypalConfig();
  if (!config) throw new ShopError(503, "Payments aren't set up yet.");
  const res = await fetch(`${config.base}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${await paypalToken(config)}`,
      "Content-Type": "application/json",
      ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });
  return { status: res.status, data: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

function paypalProblem(data: Record<string, unknown>, status: number): string {
  const details = data.details as { issue?: string; description?: string }[] | undefined;
  return `PayPal: ${details?.[0]?.description ?? data.message ?? `HTTP ${status}`}`;
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

const money = (cents: number) => (cents / 100).toFixed(2);

// Starts buying `packId` for the signed-in user (whose account must exist):
// makes the PayPal order and says where to send them to approve it. They
// come back to `returnBase`/account.
export async function startOrder(
  user: { id: string; email: string },
  packId: string,
  returnBase: string
): Promise<{ orderId: string; approveUrl: string }> {
  if (!paypalConfig()) throw new ShopError(503, "Payments aren't set up yet.");
  const file = await readTokenFile();
  const shop = shopOf(file);
  const pack = shop.packs.find((p) => p.id === packId && p.active);
  if (!pack) throw new ShopError(404, "That pack isn't for sale.");
  if (!pricing(pack, shop.market).withinLimit) throw new ShopError(409, "That pack isn't for sale right now.");
  const account = file.accounts.find((a) => a.userId === user.id);
  if (!account) throw new ShopError(409, "Your account isn't ready yet: reload the page and try again.");
  if (account.disabled) throw new ShopError(403, "Your account is turned off, so it can't buy packs.");
  const lose = wouldLose(account, pack.providers);
  if (lose) throw new ShopError(409, lose);

  const { status, data } = await paypal("/v2/checkout/orders", {
    method: "POST",
    requestId: randomUUID(),
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: pack.id,
          custom_id: user.id,
          description: `${pack.name}: ${pack.tokens.toLocaleString("en")} tokens`.slice(0, 127),
          amount: { currency_code: CURRENCY, value: money(pack.priceCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Thun Murex",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: `${returnBase}/account?paypal=return`,
            cancel_url: `${returnBase}/account?paypal=cancel`,
          },
        },
      },
    },
  });
  const order = data as unknown as PayPalOrder;
  const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  if (status >= 300 || !order.id || !approve) throw new ShopError(502, paypalProblem(data, status));

  await changeTokenFile((f) => {
    shopOf(f).orders.push({
      id: order.id,
      packId: pack.id,
      packName: pack.name,
      grant: grantOf(pack),
      priceCents: pack.priceCents,
      currency: CURRENCY,
      userId: user.id,
      email: user.email,
      status: "created",
      createdAt: new Date().toISOString(),
      paidAt: null,
      captureId: null,
      code: null,
      applied: null,
    });
  });
  return { orderId: order.id, approveUrl: approve };
}

// Starts depositing arbitrary or predefined credit for the signed-in user:
// creates the PayPal order and returns the approveUrl.
export async function startDepositOrder(
  user: { id: string; email: string },
  amountCents: number,
  returnBase: string
): Promise<{ orderId: string; approveUrl: string }> {
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents < 100 ||
    amountCents > 100_000
  ) {
    throw new ShopError(
      400,
      "Deposit amount must be a whole number of cents between 100 ($1.00) and 100,000 ($1,000.00)."
    );
  }
  if (!paypalConfig()) throw new ShopError(503, "Payments aren't set up yet.");
  const file = await readTokenFile();
  const account = file.accounts.find((a) => a.userId === user.id);
  if (!account) throw new ShopError(409, "Your account isn't ready yet: reload the page and try again.");
  if (account.disabled) throw new ShopError(403, "Your account is turned off, so it can't deposit credit.");

  const usdValue = money(amountCents);
  const { status, data } = await paypal("/v2/checkout/orders", {
    method: "POST",
    requestId: randomUUID(),
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "credit-deposit",
          custom_id: user.id,
          description: `Credit deposit: $${usdValue}`,
          amount: { currency_code: CURRENCY, value: usdValue },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Thun Murex",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: `${returnBase}/account?paypal=return`,
            cancel_url: `${returnBase}/account?paypal=cancel`,
          },
        },
      },
    },
  });
  const order = data as unknown as PayPalOrder;
  const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  if (status >= 300 || !order.id || !approve) throw new ShopError(502, paypalProblem(data, status));

  await changeTokenFile((f) => {
    shopOf(f).orders.push({
      id: order.id,
      type: "deposit",
      packId: "credit-deposit",
      packName: `Deposit $${usdValue} credit`,
      grant: { kind: "topup", plan: null, addTokens: null, addRequests: null, addDays: null },
      priceCents: amountCents,
      creditCents: amountCents,
      currency: CURRENCY,
      userId: user.id,
      email: user.email,
      status: "created",
      createdAt: new Date().toISOString(),
      paidAt: null,
      captureId: null,
      code: null,
      applied: null,
    });
  });
  return { orderId: order.id, approveUrl: approve };
}

// Orders being finished right now: a reload or a second click waits for the
// first instead of capturing twice.
const finishing = new Map<string, Promise<Order>>();

// After the buyer approved the order on PayPal: takes the payment, and gives
// them the pack. Safe to call again: a paid order just comes back as it is.
export async function finishOrder(user: { id: string }, orderId: string): Promise<Order> {
  const running = finishing.get(orderId);
  if (running) return running;
  const run = finish(user, orderId).finally(() => finishing.delete(orderId));
  finishing.set(orderId, run);
  return run;
}

async function finish(user: { id: string }, orderId: string): Promise<Order> {
  const file = await readTokenFile();
  const order = shopOf(file).orders.find((o) => o.id === orderId && o.userId === user.id);
  if (!order) throw new ShopError(404, "You have no order with that id.");
  if (order.status === "paid" || order.status === "cancelled") return order;

  let { status, data } =
    order.status === "pending"
      ? await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" })
      : await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
          method: "POST",
          body: {},
          requestId: `capture-${orderId}`,
        });
  const issue = (data.details as { issue?: string }[] | undefined)?.[0]?.issue;
  if (status === 422 && issue === "ORDER_ALREADY_CAPTURED") {
    ({ status, data } = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" }));
  }
  if (status === 422 && issue === "ORDER_NOT_APPROVED") {
    throw new ShopError(402, "The payment wasn't approved on PayPal. Try buying again.");
  }
  if (status >= 300) throw new ShopError(502, paypalProblem(data, status));

  const paid = data as unknown as PayPalOrder;
  const unit = paid.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) throw new ShopError(402, "PayPal hasn't taken the payment. Try buying again.");
  // It has to be this order, for this buyer, for the right amount.
  if (capture.amount.currency_code !== order.currency || capture.amount.value !== money(order.priceCents) || (unit?.custom_id && unit.custom_id !== order.userId)) {
    throw new ShopError(409, "That payment doesn't match the order. Contact us with the order id.");
  }

  return changeTokenFile((f) => {
    const o = shopOf(f).orders.find((x) => x.id === orderId)!;
    if (o.status === "paid") return o;
    if (capture.status !== "COMPLETED") {
      // e.g. an eCheck: PayPal has it, the money hasn't cleared. Checking
      // again later finishes it.
      o.status = "pending";
      o.captureId = capture.id;
      return o;
    }
    if (o.type === "deposit" || o.packId === "credit-deposit") {
      const amountUSD = o.priceCents / 100;
      const account = f.accounts.find((a) => a.userId === o.userId);
      if (account) {
        const curr = account.creditBalance ?? account.balance ?? 0;
        const next = Math.max(0, Number((curr + amountUSD).toFixed(6)));
        const nextCents = Math.round(next * 100);
        account.balance = next;
        account.creditBalance = next;
        account.creditBalanceCents = nextCents;
        account.activatedAt ??= new Date().toISOString();

        const tx = {
          id: randomUUID().slice(0, 16),
          userId: o.userId,
          type: "deposit" as const,
          amountCents: o.priceCents,
          amountUSD,
          balanceAfterCents: nextCents,
          balanceAfterUSD: next,
          description: `PayPal deposit (${o.id}): +$${amountUSD.toFixed(2)}`,
          orderId: o.id,
          createdAt: new Date().toISOString(),
        };
        account.transactions = Array.isArray(account.transactions) ? account.transactions : [];
        account.transactions.push(tx);
      }
      const applied = `Added $${amountUSD.toFixed(2)} to your credit balance.`;
      Object.assign(o, { status: "paid", paidAt: new Date().toISOString(), captureId: capture.id, code: null, applied });
      return o;
    }

    const code = issueCodeIn(f, o.grant, `PayPal order ${o.id} · ${o.email}`);
    // Redeemed now, unless that would throw away tokens bought before (their
    // plan changed since they ordered): then it's kept for them to redeem.
    const account = f.accounts.find((a) => a.userId === o.userId);
    let applied: string | null = null;
    if (account && !wouldLose(account, o.grant.plan?.providers ?? null)) {
      try {
        applied = redeemIn(f, { id: o.userId, email: o.email }, code.code);
      } catch (err) {
        if (!(err instanceof RedeemError)) throw err; // kept for them to redeem later
      }
    }
    Object.assign(o, { status: "paid", paidAt: new Date().toISOString(), captureId: capture.id, code: code.code, applied });
    return o;
  });
}

// The buyer went back from PayPal without paying.
export async function cancelOrder(user: { id: string }, orderId: string): Promise<Order> {
  return changeTokenFile((file) => {
    const order = shopOf(file).orders.find((o) => o.id === orderId && o.userId === user.id);
    if (!order) throw new ShopError(404, "You have no order with that id.");
    if (order.status === "created") order.status = "cancelled";
    return order;
  });
}

// What the buyer sees of their orders, newest first: the code only while it
// waits to be redeemed.
export async function ordersOf(userId: string) {
  return [...shopOf(await readTokenFile()).orders]
    .filter((o) => o.userId === userId && o.status !== "created" && o.status !== "cancelled")
    .reverse()
    .map((o) => ({
      id: o.id,
      type: o.type ?? "pack",
      packName: o.packName,
      priceCents: o.priceCents,
      creditCents: o.creditCents ?? (o.type === "deposit" ? o.priceCents : null),
      currency: o.currency,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      applied: o.applied,
      code: o.applied ? null : o.code,
    }));
}
