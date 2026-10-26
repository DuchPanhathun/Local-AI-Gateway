"use client";

// /account: sign up and in with Supabase (email and password), then the
// user's own dashboard: what their plan allows and has left, their API keys,
// and their usage. The plan is set by the owner on the console's Users page;
// a new account waits until the owner activates it.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  ago,
  limitsText,
  STATUS_BADGES,
  UsageCell,
  type KeyStatus,
} from "../api-keys";
import { Logo } from "../logo";
import styles from "../page.module.css";
import { PROVIDER_OPTIONS } from "../providers";
import { CopyButton, formatCount, UsagePanel, type MonthUsage, type UsageCounts } from "../ui";

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
};

type Mode = "signin" | "signup" | "forgot" | "reset";

const LABELS = new Map<string, string>(PROVIDER_OPTIONS.map((p) => [p.id, p.label]));
const PERIOD_USED = { day: "today", month: "this month", total: "in total" };
const REFRESH_MS = 30_000;
const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

function exampleCall(base: string, key: string): string {
  return `curl ${base}/api/chat \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "groq", "messages": [{"role": "user", "content": "Hello!"}]}'`;
}

export function AccountDashboard() {
  const [session, setSession] = useState<Session | null | undefined>(
    undefined,
  );
  const [mode, setMode] = useState<Mode>("signin");
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
          setError(json.error || `Failed (HTTP ${res.status})`);
          return null;
        }
        return json;
      } catch {
        setError("Network error reaching the gateway");
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
  }, [call, month]);

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
          setError(
            /not confirmed/i.test(error.message)
              ? "Confirm your email address first: open the link we sent you."
              : error.message,
          );
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
          setError(error.message);
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
          setError(error.message);
          return;
        }
        setNotice("If there's an account with that email, a link to reset its password is on its way.");
        setMode("signin");
      } else {
        const { error } = await sb.auth.updateUser({ password });
        if (error) {
          setError(error.message);
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
      signup: "Make an account. Once the admin activates it, you can make API keys here.",
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

  return (
    <div className={styles.accountShell}>
      <header className={styles.accountHeader}>
        <div className={styles.brand}>
          <Logo className={styles.brandMark} />
          <span className={styles.brandText}>
            <span className={styles.brandName}>Thun Murex</span>
            <span className={styles.brandSub}>{session.user.email}</span>
          </span>
        </div>
        <nav className={styles.headerActions}>
          {data?.user.admin && (
            <Link href="/" className={styles.buttonGhost}>
              Admin console
            </Link>
          )}
          <Link href="/documents" className={styles.buttonGhost}>
            Docs
          </Link>
          <button type="button" className={styles.buttonGhost} onClick={signOut}>
            Sign out
          </button>
        </nav>
      </header>

      {error && (
        <div className={styles.alert} style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {!data || !plan ? (
        <p className={styles.empty}>Loading…</p>
      ) : (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Your plan</span>
              <span
                className={`${styles.badge} ${STATUS_BADGES[plan.status].className}`}
              >
                {STATUS_BADGES[plan.status].label}
              </span>
            </div>
            {plan.status === "pending" ? (
              <p className={styles.sectionDesc}>
                Your account is waiting to be activated. Once the admin sets
                what it can use, you can make API keys here.
              </p>
            ) : (
              <>
                <p className={styles.sectionDesc}>
                  {limitsText(plan)}.{" "}
                  {plan.providers
                    ? `Providers: ${plan.providers.map((p) => LABELS.get(p) ?? p).join(", ")}.`
                    : "Every provider."}
                  {plan.resetsAt &&
                    ` Your ${plan.limits.period === "day" ? "daily" : "monthly"} limits start over on ${new Date(plan.resetsAt).toLocaleString()}.`}
                  {plan.status === "disabled" &&
                    " The admin has turned your account off for now."}
                </p>
                <div className={styles.twoCol}>
                  <div className={styles.planFigure}>
                    <span className={styles.label}>Tokens {when}</span>
                    <UsageCell
                      used={plan.used.tokens}
                      limit={plan.limits.tokens}
                      note={
                        plan.remaining.tokens !== null
                          ? `${plan.remaining.tokens.toLocaleString()} left`
                          : "no limit"
                      }
                    />
                  </div>
                  <div className={styles.planFigure}>
                    <span className={styles.label}>Requests {when}</span>
                    <UsageCell
                      used={plan.used.requests - plan.used.errors}
                      limit={plan.limits.requests}
                      note={
                        plan.remaining.requests !== null
                          ? `${plan.remaining.requests.toLocaleString()} left`
                          : "no limit"
                      }
                    />
                  </div>
                </div>
              </>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>API keys</span>
              <span className={styles.badge}>
                {data.keys.length} of {plan.maxKeys}
              </span>
            </div>
            <p className={styles.sectionDesc}>
              Send one in the <code>Authorization: Bearer</code> header. Your
              keys share your plan. Keep them secret: anyone with one can use
              what&apos;s left on it.
            </p>

            {plan.status !== "pending" && data.keys.length < plan.maxKeys && (
              <form onSubmit={createKey} className={styles.inlineForm}>
                <input
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="Name, e.g. my-bot"
                  className={styles.input}
                  maxLength={100}
                />
                <button
                  type="submit"
                  className={styles.button}
                  disabled={busy !== null}
                >
                  {busy === "create" ? "Creating…" : "Create key"}
                </button>
              </form>
            )}

            {revealed && (
              <div className={styles.reveal}>
                <div className={styles.revealLabel}>
                  Your key “{revealed.name}”. Copy it now — it won&apos;t be
                  shown again.
                </div>
                <div className={styles.revealRow}>
                  <span className={styles.revealValue}>{revealed.secret}</span>
                  <CopyButton value={revealed.secret} />
                  <CopyButton
                    label="Copy example"
                    value={exampleCall(base, revealed.secret)}
                  />
                  <button
                    type="button"
                    className={styles.buttonGhost}
                    onClick={() => setRevealed(null)}
                  >
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
                          <div className={`${styles.mono} ${styles.cellNote}`}>
                            {k.hint}
                          </div>
                        </td>
                        <td className={styles.dim}>
                          {new Date(k.createdAt).toLocaleDateString()}
                        </td>
                        <td className={styles.dim}>
                          {ago(k.lastUsedAt, loadedAt)}
                        </td>
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
              plan.status !== "pending" && (
                <p className={styles.empty}>No keys yet.</p>
              )
            )}
          </section>

          {plan.status !== "pending" && (
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
          )}

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Calling the API</span>
            </div>
            <p className={styles.sectionDesc}>
              The address is <code>{base}</code>. Every endpoint, model and
              option is in the <Link href="/documents" className={styles.inlineLink}>docs</Link>.
              Check what a key has left with <code>GET /api/me</code>.
            </p>
            <div className={styles.codeBlock}>
              <div className={styles.codeBlockBody}>
                <pre className={styles.pre}>
                  {exampleCall(base, "$YOUR_KEY")}
                </pre>
                <CopyButton value={exampleCall(base, "$YOUR_KEY")} />
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
