"use client";

// /account: sign up and in with Supabase (email and password), then the
// user's own dashboard: what their plan allows and has left, their API keys,
// and their usage. The plan is set by the owner on the console's Users page;
// a new account waits until the owner activates it.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  ago,
  limitsText,
  STATUS_BADGES,
  TOOL_ONLY,
  UsageCell,
  type KeyStatus,
} from "../api-keys";
import { Icon, type IconName } from "../icons";
import { Logo } from "../logo";
import styles from "../page.module.css";
import { MODEL_NAMES, PROVIDER_OPTIONS } from "../providers";
import { CopyButton, formatCount, UsagePanel, type MonthUsage, type UsageCounts } from "../ui";
import { DEFAULT_PACKS } from "@/lib/token-packs";
import { getModelPricing } from "@/lib/pricing";
import type { CreditTransaction } from "@/lib/api-tokens";

type Plan = {
  status: KeyStatus;
  expiresAt: string | null;
  limits: {
    period: "day" | "month" | "total";
    tokens: number | null;
    requests: number | null;
    perMinute: number | null;
  };
  providers: string[] | null;
  agentTools: boolean;
  lastUsedAt: string | null;
  used: UsageCounts;
  remaining: { tokens: number | null; requests: number | null };
  resetsAt: string | null;
  total: UsageCounts;
  email: string;
  createdAt: string;
  activatedAt: string | null;
  maxKeys: number;
  balance?: number;
  creditBalance?: number;
  creditBalanceCents?: number;
  transactions?: CreditTransaction[];
};

type OwnKey = {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  disabled: boolean;
  lastUsedAt: string | null;
  total: UsageCounts;
};

type AccountData = {
  user: { id: string; email: string; admin: boolean };
  account: Plan;
  keys: OwnKey[];
  usage: MonthUsage;
  months: string[];
  publicOrigin: string | null;
  unavailable?: string[]; // providers turned away right now: not listed as models to use
};

type Pack = {
  id: string;
  name: string;
  description: string;
  tokens: number;
  providers: string[] | null;
  days: number | null;
  priceCents: number;
  pricing: { marketCents: number | null; savingPercent: number | null };
};

type Purchase = {
  id: string;
  packName: string;
  priceCents: number;
  status: "pending" | "paid";
  createdAt: string;
  paidAt: string | null;
  applied: string | null;
  code: string | null; // only while it waits to be redeemed
  type?: "pack" | "deposit";
  amountUSD?: number;
  creditCents?: number;
};

type ShopData = {
  packs: Pack[];
  payments: { configured: boolean; live: boolean };
  orders: Purchase[];
};

type Mode = "signin" | "signup" | "forgot" | "reset";

type AccountView = "overview" | "keys" | "usage" | "buy";

const VIEWS: { id: AccountView; label: string; icon: IconName; description: string }[] = [
  { id: "overview", label: "Overview", icon: "dashboard", description: "Your plan, credit balance, what's left on it, and codes." },
  { id: "keys", label: "API keys", icon: "key", description: "Keys for your apps. They all share your plan and credit balance." },
  { id: "usage", label: "Usage", icon: "analytics", description: "What your keys have used, by day and model (UTC)." },
  { id: "buy", label: "Deposit & Packs", icon: "cart", description: "Deposit credits for pay-as-you-go model access, or buy prepaid token packs with PayPal." },
];

// Customers see models, never how they're reached.
const LABELS = new Map<string, string>(Object.entries(MODEL_NAMES));
const PERIOD_USED = { day: "today", month: "this month", total: "in total" };
const REFRESH_MS = 30_000;
const PRESET_DEPOSITS = [5, 10, 25, 50, 100];
const formatUSD = (amount: number) => {
  if (amount === 0) return "$0.00";
  if (amount < 0.01 && amount > 0) return "$" + amount.toFixed(4);
  return "$" + amount.toFixed(2);
};
const usd = (cents: number) => "$" + (cents / 100).toFixed(2);
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

// Supabase's sign-in messages, in plainer words where it helps.
function authMessage(message: string): string {
  if (/not confirmed/i.test(message)) return "Confirm your email address first: open the link we sent you.";
  if (/rate limit/i.test(message)) {
    return "Too many emails have gone out in the last hour, so we can't send another yet. Try again in an hour.";
  }
  return message;
}

function exampleCall(base: string, key: string, provider = "groq"): string {
  return `curl ${base}/api/chat \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "${provider}", "messages": [{"role": "user", "content": "Hello!"}]}'`;
}

export function AccountDashboard() {
  const [session, setSession] = useState<Session | null | undefined>(
    undefined,
  );
  const [mode, setMode] = useState<Mode>("signin");
  const [view, setView] = useState<AccountView>("overview");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [data, setData] = useState<AccountData | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [month, setMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [keyName, setKeyName] = useState("");
  const [codeText, setCodeText] = useState("");
  const [redeemed, setRedeemed] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [shop, setShop] = useState<ShopData | null>(null);
  const [shopNotice, setShopNotice] = useState<string | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);
  const paypalHandled = useRef(false);
  const [depositAmount, setDepositAmount] = useState<number>(10);
  const [customAmount, setCustomAmount] = useState<string>("10");
  const [revealed, setRevealed] = useState<{
    name: string;
    secret: string;
  } | null>(null);
  const [origin] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );

  // The session Supabase keeps in this browser, and its changes: signing in
  // and out, refreshed tokens, and a password reset link that was opened.
  useEffect(() => {
    const sb = supabaseBrowser();
    if (!sb) return;
    let active = true;
    void sb.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === "PASSWORD_RECOVERY") setMode("reset");
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const token = session?.access_token;

  const call = useCallback(
    async (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
      onError: (message: string) => void = setError,
    ): Promise<Record<string, unknown> | null> => {
      if (!token) return null;
      try {
        const res = await fetch(path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          onError(json.error || `Failed (HTTP ${res.status})`);
          return null;
        }
        return json;
      } catch {
        onError("Network error reaching the gateway");
        return null;
      }
    },
    [token],
  );

  const load = useCallback(async () => {
    const json = await call("GET", `/api/account?month=${month}`);
    if (json) {
      setData(json as AccountData);
      setLoadedAt(Date.now());
    }
    const shopJson = await call("GET", "/api/account/shop", undefined, setShopError);
    if (shopJson) setShop(shopJson as unknown as ShopData);
  }, [call, month]);

  // Back from PayPal (/account?paypal=return&token=<order id>, or
  // paypal=cancel): finish or cancel that order, once, then tidy the address.
  useEffect(() => {
    if (!token || paypalHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("paypal");
    const orderId = params.get("token");
    if (!outcome || !orderId) return;
    paypalHandled.current = true;
    window.history.replaceState(null, "", "/account");
    async function run() {
      if (outcome === "cancel") {
        setView("buy");
        await call("PATCH", `/api/account/orders?id=${encodeURIComponent(orderId!)}`, { action: "cancel" }, setShopError);
        setShopNotice("You cancelled the payment: nothing was charged.");
        return;
      }
      setView("buy");
      setShopNotice("Finishing your payment…");
      const json = await call(
        "PATCH",
        `/api/account/orders?id=${encodeURIComponent(orderId!)}`,
        { action: "finish" },
        setShopError,
      );
      if (!json) {
        setShopNotice(null);
        return;
      }
      setShopNotice(
        json.status === "pending"
          ? "PayPal has your payment but it hasn't cleared yet. Your credit or tokens are added once it does: check again under Your purchases."
          : json.type === "deposit" || json.creditCents
            ? `Thank you! ${formatUSD(Number(json.creditCents ?? json.priceCents ?? 0) / 100)} deposit credited to your balance.`
            : json.applied
              ? `Thank you! ${json.applied}`
              : `Thank you! Your payment went through, but the pack couldn't be added to your plan yet. Redeem this code when it can: ${json.code}`,
      );
      await load();
    }
    void run();
  }, [token, call, load]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    async function tick() {
      if (!cancelled) await load();
    }
    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, load]);

  // -------------------------------------------------------------------------
  // Signing in and out
  // -------------------------------------------------------------------------

  async function handleAuth(e: FormEvent) {
    e.preventDefault();
    const sb = supabaseBrowser();
    if (!sb) return;
    setError(null);
    setNotice(null);
    setBusy("auth");
    try {
      if (mode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) {
          setError(authMessage(error.message));
          return;
        }
        setPassword("");
      } else if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${origin}/account` },
        });
        if (error) {
          setError(authMessage(error.message));
          return;
        }
        setPassword("");
        if (!data.session) {
          setNotice(
            "Almost there: open the link we emailed you to confirm your address, then sign in.",
          );
          setMode("signin");
        }
      } else if (mode === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: `${origin}/account`,
        });
        if (error) {
          setError(authMessage(error.message));
          return;
        }
        setNotice("If there's an account with that email, a link to reset its password is on its way.");
        setMode("signin");
      } else {
        const { error } = await sb.auth.updateUser({ password });
        if (error) {
          setError(authMessage(error.message));
          return;
        }
        setPassword("");
        setNotice("Your password is changed.");
        setMode("signin");
      }
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    await supabaseBrowser()?.auth.signOut();
    setData(null);
    setRevealed(null);
    setError(null);
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  async function createKey(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("create");
    try {
      const json = await call("POST", "/api/account/keys", {
        name: keyName || "untitled",
      });
      if (!json) return;
      const key = json.key as OwnKey;
      setRevealed({ name: key.name, secret: json.token as string });
      setKeyName("");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function deposit(amount: number) {
    if (!amount || isNaN(amount) || amount < 1) {
      setShopError("Minimum deposit amount is $1.00");
      return;
    }
    setShopError(null);
    setShopNotice(null);
    setBusy("deposit");
    try {
      const json = await call(
        "POST", "/api/account/orders", { amountUSD: amount, amount: amount, amountCents: Math.round(amount * 100), depositAmountCents: Math.round(amount * 100), depositAmount: amount },
        setShopError,
      );
      if (json?.approveUrl) {
        setShopNotice("Taking you to PayPal…");
        window.location.href = json.approveUrl as string;
        return;
      }
    } finally {
      setBusy(null);
    }
  }

  async function buy(pack: Pack) {
    setShopError(null);
    setShopNotice(null);
    setBusy(pack.id);
    try {
      const json = await call("POST", "/api/account/orders", { packId: pack.id }, setShopError);
      if (json?.approveUrl) {
        setShopNotice("Taking you to PayPal…");
        window.location.href = json.approveUrl as string;
        return;
      }
    } finally {
      setBusy(null);
    }
  }

  async function checkAgain(order: Purchase) {
    setShopError(null);
    setBusy(order.id);
    try {
      const json = await call("PATCH", `/api/account/orders?id=${encodeURIComponent(order.id)}`, { action: "finish" }, setShopError);
      if (json) {
        setShopNotice(json.status === "pending" ? "It still hasn't cleared." : (json.applied as string) ?? "Paid.");
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  async function redeemCode(e: FormEvent) {
    e.preventDefault();
    setRedeemError(null);
    setRedeemed(null);
    setBusy("redeem");
    try {
      const json = await call(
        "POST",
        "/api/account/redeem",
        { code: codeText },
        setRedeemError,
      );
      if (!json) return;
      setRedeemed(json.applied as string);
      setCodeText("");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function rotateKey(k: OwnKey) {
    if (
      !confirm(
        `Make a new secret for “${k.name}”? The current one stops working at once.`,
      )
    )
      return;
    setError(null);
    setBusy(k.id);
    try {
      const json = await call(
        "PATCH",
        `/api/account/keys?id=${encodeURIComponent(k.id)}`,
        { rotate: true },
      );
      if (!json) return;
      setRevealed({ name: k.name, secret: json.token as string });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function deleteKey(k: OwnKey) {
    if (
      !confirm(`Delete “${k.name}”? Anything using it stops working at once.`)
    )
      return;
    setError(null);
    setBusy(k.id);
    try {
      if (
        await call("DELETE", `/api/account/keys?id=${encodeURIComponent(k.id)}`)
      ) {
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  // -------------------------------------------------------------------------
  // Signed out: the forms
  // -------------------------------------------------------------------------

  if (!CONFIGURED) {
    return (
      <main className={styles.loginWrap}>
        <div className={styles.loginCard}>
          <p className={styles.subtitle}>
            Accounts aren&apos;t set up on this server yet.
          </p>
        </div>
      </main>
    );
  }

  if (session === undefined) return <main className={styles.loginWrap} />;

  if (!session || mode === "reset") {
    const titles: Record<Mode, string> = {
      signin: "Sign in to your account to see your API keys and what you've used.",
      signup: "Make an account to get API keys, buy tokens and see what you've used.",
      forgot: "Type your email address, and we'll send a link to reset your password.",
      reset: "Choose a new password.",
    };
    const buttons: Record<Mode, [string, string]> = {
      signin: ["Sign in", "Signing in…"],
      signup: ["Create account", "Creating…"],
      forgot: ["Send the link", "Sending…"],
      reset: ["Save password", "Saving…"],
    };
    return (
      <main className={styles.loginWrap}>
        <div className={styles.loginCard}>
          <div className={styles.brand}>
            <Logo className={styles.brandMark} />
            <span className={styles.brandText}>
              <span className={styles.brandName}>Thun Murex</span>
              <span className={styles.brandSub}>Your account</span>
            </span>
          </div>
          <p className={styles.subtitle}>{titles[mode]}</p>
          <form onSubmit={handleAuth} className={styles.authForm}>
            {mode !== "reset" && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  className={styles.input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            )}
            {mode !== "forgot" && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="password">
                  {mode === "reset" ? "New password" : "Password"}
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete={
                    mode === "signin" ? "current-password" : "new-password"
                  }
                  className={styles.input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={mode === "signin" ? undefined : 8}
                  required
                />
              </div>
            )}
            <button
              type="submit"
              className={`${styles.button} ${styles.buttonFull}`}
              disabled={busy !== null}
            >
              {buttons[mode][busy ? 1 : 0]}
            </button>
          </form>
          {error && (
            <div className={styles.alert} style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
          {notice && (
            <div className={styles.notice} style={{ marginTop: 14 }}>
              {notice}
            </div>
          )}
          <div className={styles.authLinks}>
            {mode === "signin" ? (
              <>
                <button type="button" className={styles.linkButton} onClick={() => { setMode("signup"); setError(null); }}>
                  Create an account
                </button>
                <button type="button" className={styles.linkButton} onClick={() => { setMode("forgot"); setError(null); }}>
                  Forgot your password?
                </button>
              </>
            ) : (
              <button type="button" className={styles.linkButton} onClick={() => { setMode("signin"); setError(null); }}>
                Back to sign in
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------------------
  // Signed in: the dashboard
  // -------------------------------------------------------------------------

  const plan = data?.account;
  const base = data?.publicOrigin ?? origin;
  const today = new Date(loadedAt || 0).toISOString().slice(0, 10);
  const when = plan ? PERIOD_USED[plan.limits.period] : "";
  const pending = plan?.status === "pending";
  const creditBalance = plan?.creditBalance ?? plan?.balance ?? ((plan?.creditBalanceCents ?? 0) / 100);
  const hasCredit = creditBalance > 0;
  // When credit is available, all models are unlocked!
  const allProviders = PROVIDER_OPTIONS.map((p) => p.id as string);
  // A provider the owner paused (or that isn't working) isn't shown at all: it
  // can't be used now, so it's neither a model to use nor the example's.
  const unavailable = new Set(data?.unavailable ?? []);
  const models = (
    hasCredit
      ? allProviders
      : (plan?.providers ?? allProviders).filter(
          (id) => plan?.agentTools || !TOOL_ONLY.includes(id),
        )
  ).filter((id) => !unavailable.has(id));
  const firstModel = models[0] ?? "groq";
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  const redeemSection = (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Redeem a code</span>
      </div>
      <p className={styles.sectionDesc}>
        {pending
          ? "Have a code? It activates your account."
          : "A plan code renews or changes your plan; a top-up code adds to it."}
      </p>
      <form onSubmit={redeemCode} className={styles.inlineForm}>
        <input
          value={codeText}
          onChange={(e) => setCodeText(e.target.value)}
          placeholder="XXXX-XXXX-XXXX"
          className={`${styles.input} ${styles.mono}`}
          autoComplete="off"
          spellCheck={false}
          maxLength={60}
          aria-label="Code"
        />
        <button
          type="submit"
          className={styles.button}
          disabled={busy !== null || !codeText.trim()}
        >
          {busy === "redeem" ? "Redeeming…" : "Redeem"}
        </button>
      </form>
      {redeemError && <div className={styles.alert}>{redeemError}</div>}
      {redeemed && (
        <div className={styles.reveal} style={{ marginBottom: 0 }}>
          <div className={styles.revealLabel} style={{ marginBottom: 0 }}>
            {redeemed}
          </div>
        </div>
      )}
    </section>
  );

  const overviewView = plan && data && (
    <>
      {hasCredit && (
        <div className={styles.reveal} style={{ marginBottom: 20 }}>
          <div className={styles.revealLabel} style={{ marginBottom: 4, fontWeight: 600 }}>
            Pay-As-You-Go Active ({formatUSD(creditBalance)} available)
          </div>
          <div className={styles.cellNote}>
            All models and agent tools are unlocked. Request costs are deducted per token at wholesale provider rates.
          </div>
        </div>
      )}

      {pending && !hasCredit && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Activate your account</span>
          </div>
          <p className={styles.sectionDesc}>
            Your account has no plan yet, so its keys don&apos;t work. Buy a
            pack of tokens or redeem a code, and it&apos;s active at once (or
            wait for the admin to set it up). You can make your API keys now.
          </p>
          <div className={styles.actionList}>
            <button type="button" className={styles.actionRow} onClick={() => setView("buy")}>
              <span className={styles.statIcon}>
                <Icon name="cart" />
              </span>
              <span>
                <span className={styles.actionTitle}>Buy tokens</span>
                <span className={styles.actionDesc}>10 times cheaper than the market, with PayPal</span>
              </span>
            </button>
            <button type="button" className={styles.actionRow} onClick={() => setView("keys")}>
              <span className={styles.statIcon}>
                <Icon name="key" />
              </span>
              <span>
                <span className={styles.actionTitle}>Make an API key</span>
                <span className={styles.actionDesc}>It works once your account is active</span>
              </span>
            </button>
          </div>
        </section>
      )}

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Credit balance</span>
            <span className={styles.statIcon}>
              <Icon name="cart" />
            </span>
          </div>
          <div className={styles.statValue}>
            {formatUSD(creditBalance)}
          </div>
          <div className={styles.statSub}>
            {hasCredit ? "All models unlocked · Pay-as-you-go" : "Deposit funds to unlock all models"}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Status</span>
            <span className={`${styles.badge} ${STATUS_BADGES[plan.status].className}`}>
              {STATUS_BADGES[plan.status].label}
            </span>
          </div>
          <div className={styles.statValue}>
            {pending ? "No plan" : plan.expiresAt ? new Date(plan.expiresAt).toLocaleDateString() : "No end"}
          </div>
          <div className={styles.statSub}>
            {pending ? "Buy tokens or redeem a code" : plan.expiresAt ? "When your plan ends" : "Your plan doesn't end"}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Tokens left</span>
            <span className={styles.statIcon}>
              <Icon name="hash" />
            </span>
          </div>
          <div className={styles.statValue}>
            {pending ? "0" : plan.remaining.tokens === null ? "No limit" : formatCount(plan.remaining.tokens)}
          </div>
          <div className={styles.statSub}>
            {formatCount(plan.used.tokens)} used {when}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Requests</span>
            <span className={styles.statIcon}>
              <Icon name="activity" />
            </span>
          </div>
          <div className={styles.statValue}>{formatCount(plan.used.requests - plan.used.errors)}</div>
          <div className={styles.statSub}>
            {plan.limits.requests !== null
              ? `of ${formatCount(plan.limits.requests)} ${when}`
              : `${when}${plan.used.errors ? ` · ${plan.used.errors} failed` : ""}`}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>API keys</span>
            <span className={styles.statIcon}>
              <Icon name="key" />
            </span>
          </div>
          <div className={styles.statValue}>
            {data.keys.length} <span className={styles.dim}>of {plan.maxKeys}</span>
          </div>
          <div className={styles.statSub}>They all share your plan</div>
        </div>
      </div>

      {!pending && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Your plan</span>
          </div>
          <p className={styles.sectionDesc}>
            {limitsText(plan)}.{" "}
            {plan.providers
              ? `Models: ${plan.providers.map((p) => LABELS.get(p) ?? p).join(", ")}.`
              : "Every model."}
            {plan.resetsAt &&
              ` Your ${plan.limits.period === "day" ? "daily" : "monthly"} limits start over on ${new Date(plan.resetsAt).toLocaleString()}.`}
            {plan.status === "disabled" && " The admin has turned your account off for now."}
          </p>
          <div className={styles.twoCol}>
            <div className={styles.planFigure}>
              <span className={styles.label}>Tokens {when}</span>
              <UsageCell
                used={plan.used.tokens}
                limit={plan.limits.tokens}
                note={plan.remaining.tokens !== null ? `${plan.remaining.tokens.toLocaleString()} left` : "no limit"}
              />
            </div>
            <div className={styles.planFigure}>
              <span className={styles.label}>Requests {when}</span>
              <UsageCell
                used={plan.used.requests - plan.used.errors}
                limit={plan.limits.requests}
                note={plan.remaining.requests !== null ? `${plan.remaining.requests.toLocaleString()} left` : "no limit"}
              />
            </div>
          </div>
        </section>
      )}

      {redeemSection}
    </>
  );

  const keysView = plan && data && (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Your keys</span>
          <span className={styles.badge}>
            {data.keys.length} of {plan.maxKeys}
          </span>
        </div>
        <p className={styles.sectionDesc}>
          Send one in the <code>Authorization: Bearer</code> header. Your keys
          share your plan. Keep them secret: anyone with one can use what&apos;s
          left on it.
          {pending && " Your account isn't active yet, so keys you make now start working once it is."}
        </p>

        {data.keys.length < plan.maxKeys ? (
          <form onSubmit={createKey} className={styles.inlineForm}>
            <input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Name, e.g. my-bot"
              className={styles.input}
              maxLength={100}
            />
            <button type="submit" className={styles.button} disabled={busy !== null}>
              {busy === "create" ? "Creating…" : "Create key"}
            </button>
          </form>
        ) : (
          <p className={styles.fieldHint} style={{ marginBottom: 16 }}>
            You have as many keys as your plan allows. Delete one to make another.
          </p>
        )}

        {revealed && (
          <div className={styles.reveal}>
            <div className={styles.revealLabel}>
              Your key “{revealed.name}”. Copy it now — it won&apos;t be shown again.
            </div>
            <div className={styles.revealRow}>
              <span className={styles.revealValue}>{revealed.secret}</span>
              <CopyButton value={revealed.secret} />
              <CopyButton label="Copy example" value={exampleCall(base, revealed.secret, firstModel)} />
              <button type="button" className={styles.buttonGhost} onClick={() => setRevealed(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        {data.keys.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Made</th>
                  <th>Last used</th>
                  <th>Tokens used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <div className={styles.strong}>
                        {k.name}
                        {k.disabled && (
                          <span className={styles.badge} style={{ marginLeft: 8 }}>
                            Off
                          </span>
                        )}
                      </div>
                      <div className={`${styles.mono} ${styles.cellNote}`}>{k.hint}</div>
                    </td>
                    <td className={styles.dim}>{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className={styles.dim}>{ago(k.lastUsedAt, loadedAt)}</td>
                    <td>{formatCount(k.total.tokens)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        disabled={busy !== null}
                        onClick={() => rotateKey(k)}
                      >
                        New secret
                      </button>{" "}
                      <button
                        type="button"
                        className={styles.buttonDanger}
                        disabled={busy !== null}
                        onClick={() => deleteKey(k)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>No keys yet. Name one above and create it.</p>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Calling the API</span>
        </div>
        <p className={styles.sectionDesc}>
          The address is <code>{base}</code>. Every endpoint and option is in
          the <Link href="/documents" className={styles.inlineLink}>docs</Link>.
          Check what a key has left with <code>GET /api/me</code>.
        </p>
        <div className={styles.codeBlock}>
          <div className={styles.codeBlockBody}>
            <pre className={styles.pre}>{exampleCall(base, "$YOUR_KEY", firstModel)}</pre>
            <CopyButton value={exampleCall(base, "$YOUR_KEY", firstModel)} />
          </div>
        </div>
                <div className={styles.sectionHeader} style={{ marginTop: 8 }}>
          <span className={styles.sectionTitle}>Models you can use</span>
          {hasCredit && (
            <span className={`${styles.badge} ${styles.badgeSuccess}`}>
              All models unlocked with credit
            </span>
          )}
        </div>
        <p className={styles.sectionDesc}>
          {hasCredit
            ? "Your credit balance unlocks every model and tool with pay-as-you-go pricing. Send the model provider value in your request."
            : "Send the model provider value in your request, as in the example."}
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Model</th>
                <th>provider</th>
                <th>Access</th>
                <th>Prompt rate</th>
                <th>Completion rate</th>
              </tr>
            </thead>
            <tbody>
              {models.map((id) => {
                const rate = getModelPricing(id);
                return (
                  <tr key={id}>
                    <td className={styles.strong}>{LABELS.get(id) ?? rate.model ?? id}</td>
                    <td className={styles.mono}>{id}</td>
                    <td>
                      <span className={`${styles.badge} ${hasCredit ? styles.badgeSuccess : ""}`}>
                        {hasCredit ? "Unlocked" : "Included"}
                      </span>
                    </td>
                    <td className={styles.dim}>${rate.inputPricePerMillion.toFixed(2)} / 1M</td>
                    <td className={styles.dim}>${rate.outputPricePerMillion.toFixed(2)} / 1M</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );

  const usageView = data && (
    <section className={styles.section}>
      <UsagePanel
        usage={data.usage.month === month ? data.usage : null}
        month={month}
        months={data.months}
        onMonth={setMonth}
        labels={LABELS}
        today={today}
      />
    </section>
  );

  const defaultPacks: Pack[] = DEFAULT_PACKS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    tokens: p.tokens,
    providers: p.providers,
    days: p.days,
    priceCents: p.priceCents,
    pricing: {
      marketCents: Math.round(p.marketPriceUSD * 100),
      savingPercent: p.savingPercent,
    },
  }));
  const activePacks = shop?.packs && shop.packs.length > 0 ? shop.packs : defaultPacks;

  const buyView = plan && (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Deposit credit</span>
        {shop?.payments.configured && !shop.payments.live && (
          <span className={`${styles.badge} ${styles.badgeWarning}`}>Test payments</span>
        )}
      </div>
      <p className={styles.sectionDesc}>
        Add credit to your balance to unlock all models and pay only for what you use. Paid with PayPal.
      </p>
      {shopNotice && (
        <div className={styles.reveal}>
          <div className={styles.revealLabel} style={{ marginBottom: 0 }}>
            {shopNotice}
          </div>
        </div>
      )}
      {shopError && (
        <div className={styles.alert} style={{ marginBottom: 16 }}>
          {shopError}
        </div>
      )}

      <div className={styles.depositCard}>
        <div className={styles.depositBalanceRow}>
          <div>
            <div className={styles.statLabel}>Current Credit Balance</div>
            <div className={styles.statValue} style={{ fontSize: "1.75rem", marginTop: 4 }}>
              {formatUSD(creditBalance)}
            </div>
            <div className={styles.cellNote} style={{ marginTop: 2 }}>
              {hasCredit ? "Active · Pay-as-you-go access to all models and agent tools" : "Deposit credit to unlock all models without pack limits"}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <span className={`${styles.badge} ${hasCredit ? styles.badgeSuccess : styles.badgeWarning}`}>
              {hasCredit ? "Unrestricted Access" : "Zero Balance"}
            </span>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div className={styles.fieldLabel}>Select Deposit Amount (USD)</div>
          <div className={styles.presetGrid}>
            {PRESET_DEPOSITS.map((amt) => (
              <button key={amt} type="button" className={`${styles.presetBtn} ${depositAmount === amt && customAmount === String(amt) ? styles.presetBtnActive : ""}`} onClick={() => { setDepositAmount(amt); setCustomAmount(String(amt)); }}>${amt}</button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
            <div style={{ position: "relative", width: 140 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}>$</span>
              <input type="number" min="1" max="1000" step="1" value={customAmount} onChange={(e) => { setCustomAmount(e.target.value); const num = parseFloat(e.target.value); if (!isNaN(num) && num > 0) setDepositAmount(num); }} className={styles.input} style={{ paddingLeft: 24 }} placeholder="Custom" />
            </div>
            <button type="button" className={styles.button} disabled={busy !== null || isNaN(depositAmount) || depositAmount < 1} onClick={() => deposit(depositAmount)}>{busy === "deposit" ? "Opening PayPal…" : `Deposit $${depositAmount || 0} with PayPal`}</button>
          </div>
          <p className={styles.fieldHint} style={{ marginTop: 8 }}>Deposits are credited immediately once completed via PayPal. Minimum $1.00.</p>
        </div>
      </div>

      <div className={styles.sectionHeader} style={{ marginTop: 32 }}>
        <span className={styles.sectionTitle}>Prepaid token packs</span>
      </div>
      <p className={styles.sectionDesc}>Prepaid tokens, paid with PayPal and added to your plan at once. Buying another pack for the same models adds to what you have left.</p>

      {activePacks.length > 0 ? (
        <div className={styles.packGrid}>
          {activePacks.map((p) => (
            <div key={p.id} className={styles.packCard}>
              <div className={styles.strong}>{p.name}</div>
              {p.description && <div className={styles.cellNote}>{p.description}</div>}
              <div className={styles.packPrice}>{usd(p.priceCents)}</div>
              <div className={styles.packFacts}>
                {formatCount(p.tokens)} tokens ·{" "}
                {p.providers ? p.providers.map((id) => LABELS.get(id) ?? id).join(", ") : "every model"}
                {p.days ? ` · ${p.days} days` : ""}
              </div>
              {p.pricing.marketCents !== null && (
                <div className={styles.cellNote}>
                  <s>{usd(Math.round(p.pricing.marketCents))}</s> at market price · {p.pricing.savingPercent}% less
                </div>
              )}
              <div className={styles.packBuy}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonFull}`}
                  disabled={busy !== null || (shop !== null && !shop.payments.configured) || plan.status === "disabled"}
                  onClick={() => buy(p)}
                >
                  {busy === p.id ? "Opening PayPal…" : "Buy with PayPal"}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.empty}>No packs are on sale yet. Check back soon, or redeem a code on the Overview page.</p>
      )}
      {shop && !shop.payments.configured && activePacks.length > 0 && (
        <p className={styles.fieldHint} style={{ marginTop: 10 }}>
          Payments aren&apos;t open yet. Check back soon.
        </p>
      )}
      {plan.transactions && plan.transactions.length > 0 && (
        <>
          <div className={styles.sectionHeader} style={{ marginTop: 32 }}>
            <span className={styles.sectionTitle}>Credit & deduction history</span>
          </div>
          <p className={styles.sectionDesc}>
            Recent credit deposits and per-request token usage deductions.
          </p>
          <div className={styles.tableWrap} style={{ marginTop: 8 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Balance after</th>
                </tr>
              </thead>
              <tbody>
                {plan.transactions.map((tx) => (
                  <tr key={tx.id}>
                    <td className={styles.dim} style={{ whiteSpace: "nowrap" }}>
                      {new Date(tx.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td>
                      <span
                        className={`${styles.badge} ${
                          tx.type === "deposit"
                            ? styles.badgeSuccess
                            : tx.type === "usage"
                            ? ""
                            : styles.badgeWarning
                        }`}
                      >
                        {tx.type}
                      </span>
                    </td>
                    <td>{tx.description}</td>
                    <td
                      style={{
                        whiteSpace: "nowrap",
                        fontWeight: 600,
                        color: tx.amountCents >= 0 ? "var(--success, #10b981)" : "inherit",
                      }}
                    >
                      {tx.amountCents >= 0 ? `+${formatUSD(tx.amountUSD)}` : `-${formatUSD(Math.abs(tx.amountUSD))}`}
                    </td>
                    <td className={styles.mono} style={{ whiteSpace: "nowrap" }}>
                      {formatUSD(tx.balanceAfterUSD)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {shop && shop.orders.length > 0 && (
        <>
          <div className={styles.sectionHeader} style={{ marginTop: 32 }}>
            <span className={styles.sectionTitle}>Purchases & deposits</span>
          </div>
          <div className={styles.tableWrap} style={{ marginTop: 8 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shop.orders.map((o) => (
                  <tr key={o.id}>
                    <td className={styles.dim}>{new Date(o.paidAt ?? o.createdAt).toLocaleDateString()}</td>
                    <td>{o.packName}</td>
                    <td>{usd(o.priceCents)}</td>
                    <td>
                      {o.status === "pending" ? (
                        <button type="button" className={styles.buttonGhost} disabled={busy !== null} onClick={() => checkAgain(o)}>
                          Clearing: check again
                        </button>
                      ) : o.type === "deposit" || o.creditCents ? (
                        <span className={`${styles.badge} ${styles.badgeSuccess}`}>Credited to balance</span>
                      ) : o.applied ? (
                        <span className={styles.dim}>Added to your plan</span>
                      ) : (
                        <span>
                          Code to redeem: <span className={styles.mono}>{o.code}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

    </section>
  );

  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <div className={`${styles.brand} ${styles.sidebarBrand}`}>
          <Logo className={styles.brandMark} />
          <span className={styles.brandText}>
            <span className={styles.brandName}>Thun Murex</span>
            <span className={styles.brandSub}>Your account</span>
          </span>
        </div>

        <div className={styles.navLabel}>Account</div>
        <nav className={styles.nav}>
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.navItem} ${view === item.id ? styles.navItemActive : ""}`}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} className={styles.navIcon} />
              {item.label}
            </button>
          ))}
          <Link href="/documents" className={styles.navItem}>
            <Icon name="book" className={styles.navIcon} />
            Documents
          </Link>
          {data?.user.admin && (
            <Link href="/" className={styles.navItem}>
              <Icon name="manage" className={styles.navIcon} />
              Admin console
            </Link>
          )}
        </nav>

        <div className={styles.navFooter}>
          <div className={styles.navUser} title={session.user.email}>
            {session.user.email}
          </div>
          <button type="button" className={styles.navItem} onClick={signOut}>
            <Icon name="logout" className={styles.navIcon} />
            Sign out
          </button>
        </div>
      </aside>

      <main className={styles.content}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>{current.label}</h1>
            <p className={styles.pageDesc}>{current.description}</p>
          </div>
        </div>

        {error && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {!data || !plan ? (
          <p className={styles.empty}>Loading…</p>
        ) : (
          <>
            {view === "overview" && overviewView}
            {view === "keys" && keysView}
            {view === "usage" && usageView}
            {view === "buy" && buyView}
          </>
        )}
      </main>
    </div>
  );
}
