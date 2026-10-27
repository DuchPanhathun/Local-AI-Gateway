"use client";

// The console's Shop page: prepaid token packs people buy on /account with
// PayPal, the market prices their prices are held to (at most half), and
// every order.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { amountText, parseAmount, type ProviderOption } from "./api-keys";
import styles from "./page.module.css";
import { formatCount } from "./ui";

type MarketPrice = { model: string; input: number; output: number; source: string; blended: number };

type Pricing = {
  marketCents: number | null;
  maxPriceCents: number | null;
  cheapest: { provider: string; model: string; perMillion: number } | null;
  savingPercent: number | null;
  withinLimit: boolean;
};

type Pack = {
  id: string;
  name: string;
  description: string;
  tokens: number;
  providers: string[] | null;
  agentTools: boolean;
  maxKeys: number;
  perMinute: number | null;
  days: number | null;
  priceCents: number;
  active: boolean;
  createdAt: string;
  gives: string;
  pricing: Pricing;
};

type Order = {
  id: string;
  packId: string;
  packName: string;
  priceCents: number;
  currency: string;
  email: string;
  status: "created" | "pending" | "paid" | "cancelled";
  createdAt: string;
  paidAt: string | null;
  code: string | null;
  applied: string | null;
};

type ShopData = {
  market: Record<string, MarketPrice>;
  packs: Pack[];
  orders: Order[];
  payments: { configured: boolean; live: boolean; currency: string };
  maxShare: number;
};

type PackDraft = {
  name: string;
  description: string;
  tokens: string;
  allProviders: boolean;
  providers: string[];
  days: string;
  maxKeys: string;
  perMinute: string;
  agentTools: boolean;
  price: string;
};

const EMPTY_PACK: PackDraft = {
  name: "",
  description: "",
  tokens: "1M",
  allProviders: false,
  providers: ["groq"],
  days: "30",
  maxKeys: "5",
  perMinute: "",
  agentTools: false,
  price: "",
};

const ORDER_BADGES: Record<Order["status"], { label: string; className: string }> = {
  created: { label: "Not paid", className: "" },
  pending: { label: "Clearing", className: styles.badgeWarning },
  paid: { label: "Paid", className: styles.badgeSuccess },
  cancelled: { label: "Cancelled", className: "" },
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function toDraft(p: Pack): PackDraft {
  return {
    name: p.name,
    description: p.description,
    tokens: amountText(p.tokens),
    allProviders: p.providers === null,
    providers: p.providers ?? [],
    days: p.days === null ? "" : String(p.days),
    maxKeys: String(p.maxKeys),
    perMinute: p.perMinute === null ? "" : String(p.perMinute),
    agentTools: p.agentTools,
    price: (p.priceCents / 100).toFixed(2),
  };
}

// The cheapest provider a draft covers, and what that makes its tokens worth.
function preview(d: PackDraft, market: Record<string, MarketPrice>, maxShare: number) {
  const tokens = parseAmount(d.tokens);
  const ids = (d.allProviders ? Object.keys(market) : d.providers).filter((id) => market[id]);
  if (!tokens || Number.isNaN(tokens) || !ids.length) return null;
  const low = ids.reduce((a, b) => (market[b].blended < market[a].blended ? b : a));
  const marketCents = (tokens / 1e6) * market[low].blended * 100;
  return { provider: low, marketCents, maxCents: Math.floor(marketCents * maxShare) };
}

export function Shop({ providers }: { providers: ProviderOption[] }) {
  const [data, setData] = useState<ShopData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // a pack id, or "new"
  const [draft, setDraft] = useState<PackDraft>(EMPTY_PACK);
  const [marketDraft, setMarketDraft] = useState<Record<string, { input: string; output: string }> | null>(null);

  const labels = new Map(providers.map((p) => [p.id, p.label]));

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/shop", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(json.error || `Couldn't load the shop (HTTP ${res.status})`);
        return;
      }
      setData(json);
      setLoadError(null);
    } catch {
      setLoadError("Network error reaching /api/shop");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (!cancelled) await load();
    }
    void tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load]);

  async function send(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown) {
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || `Failed (HTTP ${res.status})`);
        return null;
      }
      return json;
    } catch {
      setError("Network error reaching /api/shop");
      return null;
    }
  }

  async function act(name: string, run: () => Promise<void>) {
    setBusy(name);
    try {
      await run();
    } finally {
      setBusy(null);
    }
  }

  function packBody(d: PackDraft): Record<string, unknown> | string {
    const tokens = parseAmount(d.tokens);
    if (!tokens || Number.isNaN(tokens)) return "Tokens: type a number, like 1M.";
    const price = Number(d.price);
    if (!(price > 0)) return "Price: an amount in US dollars, like 4.99.";
    if (!d.allProviders && !d.providers.length) return "Pick at least one provider.";
    const whole = (text: string, label: string): number | null | string => {
      if (!text.trim()) return null;
      const n = Number(text);
      return Number.isInteger(n) && n > 0 ? n : `${label}: a whole number, or empty.`;
    };
    const days = whole(d.days, "Lasts");
    const perMinute = whole(d.perMinute, "Requests a minute");
    const maxKeys = Number(d.maxKeys);
    if (typeof days === "string") return days;
    if (typeof perMinute === "string") return perMinute;
    if (!Number.isInteger(maxKeys) || maxKeys < 0 || maxKeys > 100) return "Max keys: 0 to 100.";
    return {
      name: d.name,
      description: d.description,
      tokens,
      providers: d.allProviders ? null : d.providers,
      days,
      perMinute,
      maxKeys,
      agentTools: d.agentTools,
      price,
    };
  }

  async function savePack(e: FormEvent) {
    e.preventDefault();
    const body = packBody(draft);
    if (typeof body === "string") {
      setError(body);
      return;
    }
    await act("save", async () => {
      const ok =
        editing === "new"
          ? await send("POST", "/api/shop", body)
          : await send("PATCH", `/api/shop?pack=${encodeURIComponent(editing!)}`, body);
      if (!ok) return;
      setEditing(null);
      await load();
    });
  }

  async function saveMarket() {
    if (!marketDraft) return;
    const market: Record<string, { input: number; output: number }> = {};
    for (const [id, v] of Object.entries(marketDraft)) {
      const input = Number(v.input);
      const output = Number(v.output);
      if (!(input >= 0) || !(output >= 0) || v.input.trim() === "" || v.output.trim() === "") {
        setError(`${labels.get(id) ?? id}: prices are US dollars per million tokens, like 0.15.`);
        return;
      }
      market[id] = { input, output };
    }
    await act("market", async () => {
      if (await send("PATCH", "/api/shop", { market })) {
        setMarketDraft(null);
        await load();
      }
    });
  }

  const sales = new Map<string, { count: number; cents: number }>();
  for (const o of data?.orders ?? []) {
    if (o.status !== "paid") continue;
    const s = sales.get(o.packId) ?? { count: 0, cents: 0 };
    sales.set(o.packId, { count: s.count + 1, cents: s.cents + o.priceCents });
  }
  const revenue = [...sales.values()].reduce((sum, s) => sum + s.cents, 0);
  const live = data && editing ? preview(draft, data.market, data.maxShare) : null;
  const set = <K extends keyof PackDraft>(field: K, value: PackDraft[K]) => setDraft({ ...draft, [field]: value });

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Packs</span>
          <span className={styles.headerActions}>
            {/* Only when payments aren't real yet. */}
            {data && !data.payments.live && (
              <span
                className={`${styles.badge} ${data.payments.configured ? styles.badgeWarning : styles.badgeDanger}`}
              >
                {data.payments.configured ? "PayPal: sandbox" : "PayPal: not set up"}
              </span>
            )}
            <button
              type="button"
              className={editing === "new" ? styles.buttonGhost : styles.button}
              onClick={() => {
                setEditing(editing === "new" ? null : "new");
                setDraft(EMPTY_PACK);
                setError(null);
              }}
            >
              {editing === "new" ? "Cancel" : "New pack"}
            </button>
          </span>
        </div>
        <p className={styles.sectionDesc}>
          Prepaid tokens people buy on their account page with PayPal. A
          pack&apos;s price is at most half what its tokens cost at the market
          price of the cheapest provider it covers, so it&apos;s half price or
          less whichever they use. Buying another pack adds to what&apos;s left.
          Paid: {usd(revenue)} from {[...sales.values()].reduce((n, s) => n + s.count, 0)} orders.
        </p>

        {data && !data.payments.configured && (
          <div className={styles.notice}>
            Payments aren&apos;t set up: add <code>PAYPAL_CLIENT_ID</code> and{" "}
            <code>PAYPAL_CLIENT_SECRET</code> (developer.paypal.com → Apps &amp;
            Credentials) to the server&apos;s .env and restart ai-thun. Sandbox
            until you add <code>PAYPAL_ENV=live</code>.
          </div>
        )}
        {(error || loadError) && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {error || loadError}
          </div>
        )}

        {editing && data && (
          <form onSubmit={savePack} className={styles.keyPanel}>
            <div className={styles.keyForm}>
              <div className={styles.twoCol}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pack-name">Name</label>
                  <input id="pack-name" className={styles.input} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Groq 10M" maxLength={80} />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pack-desc">Description (buyers see it)</label>
                  <input id="pack-desc" className={styles.input} value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Fast open models for chatbots" maxLength={300} />
                </div>
              </div>
              <div className={styles.fourCol}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pack-tokens">Tokens</label>
                  <input id="pack-tokens" className={styles.input} inputMode="decimal" value={draft.tokens} onChange={(e) => set("tokens", e.target.value)} placeholder="e.g. 10M" />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pack-days">Lasts (days)</label>
                  <input id="pack-days" className={styles.input} inputMode="numeric" value={draft.days} onChange={(e) => set("days", e.target.value)} placeholder="No end" />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pack-rpm">Requests a minute</label>
                  <input id="pack-rpm" className={styles.input} inputMode="numeric" value={draft.perMinute} onChange={(e) => set("perMinute", e.target.value)} placeholder="No limit" />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pack-keys">Max keys</label>
                  <input id="pack-keys" className={styles.input} inputMode="numeric" value={draft.maxKeys} onChange={(e) => set("maxKeys", e.target.value)} />
                </div>
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Providers</span>
                <label className={styles.toggle}>
                  <input type="checkbox" className={styles.switch} checked={draft.allProviders} onChange={(e) => set("allProviders", e.target.checked)} />
                  <span>All of them (priced by the cheapest)</span>
                </label>
                {!draft.allProviders && (
                  <div className={styles.checkChips}>
                    {providers.map((p) => (
                      <label key={p.id} className={styles.checkChip}>
                        <input
                          type="checkbox"
                          checked={draft.providers.includes(p.id)}
                          onChange={(e) =>
                            set("providers", e.target.checked ? [...draft.providers, p.id] : draft.providers.filter((x) => x !== p.id))
                          }
                        />
                        {p.label}
                        {data.market[p.id] && (
                          <span className={styles.dim}>${data.market[p.id].blended.toFixed(2)}/M</span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.toggle}>
                  <input type="checkbox" className={styles.switch} checked={draft.agentTools} onChange={(e) => set("agentTools", e.target.checked)} />
                  <span>Agent access: the coding CLIs can read files on this machine</span>
                </label>
                <span className={styles.fieldHint}>Leave it off for packs you sell.</span>
              </div>
              <div className={styles.twoCol}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pack-price">Price (US dollars)</label>
                  <input id="pack-price" className={styles.input} inputMode="decimal" value={draft.price} onChange={(e) => set("price", e.target.value)} placeholder="e.g. 1.25" />
                  {live ? (
                    <span className={Number(draft.price) * 100 > live.maxCents ? styles.dangerText : styles.fieldHint}>
                      Market: {usd(Math.round(live.marketCents))} at {data.market[live.provider].model}&apos;s price, so at
                      most {usd(live.maxCents)}.{" "}
                      {Number(draft.price) > 0 && live.marketCents > 0 &&
                        `That's ${Math.round((1 - (Number(draft.price) * 100) / live.marketCents) * 100)}% below market.`}{" "}
                      <button type="button" className={styles.linkButton} onClick={() => set("price", (live.maxCents / 100).toFixed(2))}>
                        Use the most
                      </button>
                    </span>
                  ) : (
                    <span className={styles.fieldHint}>Type the tokens and pick providers to see the market price.</span>
                  )}
                </div>
              </div>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.buttonGhost} onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className={styles.button} disabled={busy !== null}>
                {busy === "save" ? "Saving…" : editing === "new" ? "Add the pack" : "Save the pack"}
              </button>
            </div>
          </form>
        )}

        {data && data.packs.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Price</th>
                  <th>Market</th>
                  <th>Status</th>
                  <th>Sold</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.packs.map((p) => {
                  const sold = sales.get(p.id);
                  const status = !p.pricing.withinLimit
                    ? { label: "Over the limit", className: styles.badgeDanger }
                    : p.active
                      ? { label: "On sale", className: styles.badgeSuccess }
                      : { label: "Off sale", className: "" };
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className={styles.strong}>{p.name}</div>
                        <div className={styles.cellNote}>
                          {formatCount(p.tokens)} tokens ·{" "}
                          {p.providers ? p.providers.map((id) => labels.get(id) ?? id).join(", ") : "every provider"}
                          {p.days ? ` · ${p.days} days` : ""}
                        </div>
                      </td>
                      <td className={styles.strong}>{usd(p.priceCents)}</td>
                      <td>
                        <div>{p.pricing.marketCents !== null ? usd(Math.round(p.pricing.marketCents)) : "—"}</div>
                        <div className={styles.cellNote}>
                          {p.pricing.savingPercent !== null && `${p.pricing.savingPercent}% less · `}
                          {p.pricing.cheapest?.model}
                        </div>
                      </td>
                      <td>
                        <span className={`${styles.badge} ${status.className}`}>{status.label}</span>
                        {!p.pricing.withinLimit && p.pricing.maxPriceCents !== null && (
                          <div className={styles.cellNote}>At most {usd(p.pricing.maxPriceCents)} now</div>
                        )}
                      </td>
                      <td className={styles.dim}>{sold ? `${sold.count} · ${usd(sold.cents)}` : "—"}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          onClick={() => {
                            setEditing(p.id);
                            setDraft(toDraft(p));
                            setError(null);
                          }}
                        >
                          Edit
                        </button>{" "}
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          disabled={busy !== null}
                          onClick={() =>
                            act(p.id, async () => {
                              if (await send("PATCH", `/api/shop?pack=${encodeURIComponent(p.id)}`, { active: !p.active })) await load();
                            })
                          }
                        >
                          {p.active ? "Take off sale" : "Put on sale"}
                        </button>{" "}
                        <button
                          type="button"
                          className={styles.buttonDanger}
                          disabled={busy !== null}
                          onClick={() =>
                            confirm(`Delete “${p.name}”? Its orders stay.`) &&
                            act(p.id, async () => {
                              if (await send("DELETE", `/api/shop?pack=${encodeURIComponent(p.id)}`)) await load();
                            })
                          }
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          data && editing !== "new" && <p className={styles.empty}>No packs yet. Make one with New pack.</p>
        )}
      </section>

      {data && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Market prices</span>
            {marketDraft ? (
              <span className={styles.headerActions}>
                <button type="button" className={styles.buttonGhost} onClick={() => setMarketDraft(null)}>Cancel</button>
                <button type="button" className={styles.button} disabled={busy !== null} onClick={saveMarket}>
                  {busy === "market" ? "Saving…" : "Save prices"}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() =>
                  setMarketDraft(
                    Object.fromEntries(
                      Object.entries(data.market).map(([id, p]) => [id, { input: String(p.input), output: String(p.output) }]),
                    ),
                  )
                }
              >
                Edit prices
              </button>
            )}
          </div>
          <p className={styles.sectionDesc}>
            What each provider&apos;s default model costs elsewhere, in US dollars
            per million tokens, from public price lists (October 2026). Blended
            counts 3 tokens in for each token out. Packs are held to these: when
            you lower one, a pack it puts over the limit leaves the shop until
            you lower its price.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Compared with</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Blended</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.market).map(([id, p]) => (
                  <tr key={id}>
                    <td className={styles.strong}>{labels.get(id) ?? id}</td>
                    <td>
                      <a href={p.source} target="_blank" rel="noreferrer" className={styles.inlineLink}>
                        {p.model}
                      </a>
                    </td>
                    {(["input", "output"] as const).map((field) => (
                      <td key={field}>
                        {marketDraft ? (
                          <input
                            className={styles.input}
                            style={{ width: 90 }}
                            inputMode="decimal"
                            value={marketDraft[id][field]}
                            aria-label={`${labels.get(id) ?? id} ${field}`}
                            onChange={(e) => setMarketDraft({ ...marketDraft, [id]: { ...marketDraft[id], [field]: e.target.value } })}
                          />
                        ) : (
                          `$${p[field]}`
                        )}
                      </td>
                    ))}
                    <td>${p.blended.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Orders</span>
          </div>
          {data.orders.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Buyer</th>
                    <th>Pack</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>PayPal order</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((o) => (
                    <tr key={o.id}>
                      <td className={styles.dim}>{new Date(o.paidAt ?? o.createdAt).toLocaleString()}</td>
                      <td>{o.email}</td>
                      <td>
                        <div>{o.packName}</div>
                        {o.status === "paid" && !o.applied && o.code && (
                          <div className={styles.cellNote}>Waiting to be redeemed: {o.code}</div>
                        )}
                      </td>
                      <td>{usd(o.priceCents)}</td>
                      <td>
                        <span className={`${styles.badge} ${ORDER_BADGES[o.status].className}`}>{ORDER_BADGES[o.status].label}</span>
                      </td>
                      <td className={`${styles.mono} ${styles.dim}`}>{o.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.empty}>No orders yet.</p>
          )}
        </section>
      )}
    </>
  );
}
