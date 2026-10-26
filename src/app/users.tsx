"use client";

// The console's Users page: the people who signed up on /account (Supabase
// Auth), each with their account's plan, keys and usage. A new account waits
// until it's activated here with a plan; its keys share that plan.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ago,
  amountText,
  dateInput,
  expiryCell,
  fromDraft,
  KeyFields,
  limitsText,
  parseAmount,
  STATUS_BADGES,
  toDraft,
  UsageCell,
  type Draft,
  type KeyStatus,
  type ProviderOption,
} from "./api-keys";
import styles from "./page.module.css";
import { CopyButton, formatCount, UsagePanel, type MonthUsage, type UsageCounts } from "./ui";

type Account = {
  status: KeyStatus;
  disabled: boolean;
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
  userId: string;
  email: string;
  note: string;
  createdAt: string;
  activatedAt: string | null;
  maxKeys: number;
  keyCount: number;
};

type User = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  emailConfirmed: boolean;
  admin: boolean;
  account: Account | null; // null: hasn't opened their dashboard yet
};

type UserKey = {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  disabled: boolean;
  lastUsedAt: string | null;
  total: UsageCounts;
};

type UserDetail = {
  user: Omit<User, "account">;
  account: Account | null;
  keys: UserKey[];
  usage: MonthUsage | null;
  months: string[];
};

const PERIOD_USED = { day: "today", month: "this month", total: "in total" };
const REFRESH_MS = 30_000;

// The plan form for an account that has none yet.
const NEW_PLAN = {
  note: "",
  limits: { period: "month" as const, tokens: null, requests: null, perMinute: null },
  expiresAt: null,
  providers: null,
  agentTools: false,
  maxKeys: 5,
};

export function Users({ providers }: { providers: ProviderOption[] }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailMonth, setDetailMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const [addAmount, setAddAmount] = useState("");
  const [origin] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );

  const labels = new Map(providers.map((p) => [p.id, p.label]));
  const signUpUrl = `${publicOrigin ?? origin}/account`;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || `Couldn't load the users (HTTP ${res.status})`);
        return;
      }
      setUsers(data.users);
      setPublicOrigin(data.publicOrigin ?? null);
      setLoadedAt(Date.now());
      setLoadError(null);
    } catch {
      setLoadError("Network error reaching /api/users");
    }
  }, []);

  useEffect(() => {
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
  }, [load]);

  // The selected user's keys and month, again whenever the list is refreshed.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch(
          `/api/users?id=${encodeURIComponent(selectedId!)}&month=${detailMonth}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data: UserDetail = await res.json();
        if (!cancelled) setDetail(data);
      } catch {
        // network hiccup — keep showing the last numbers
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailMonth, users]);

  const selected = users?.find((u) => u.id === selectedId) ?? null;

  function select(u: User | null) {
    setSelectedId(u?.id ?? null);
    setEditDraft(u ? toDraft(u.account ?? NEW_PLAN) : null);
    setDetail(null);
    setAddAmount("");
    setError(null);
  }

  async function send(
    method: "PATCH" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | null> {
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed (HTTP ${res.status})`);
        return null;
      }
      return data;
    } catch {
      setError("Network error reaching the gateway");
      return null;
    }
  }

  // A change to the selected user's account (or, in Supabase, to the user).
  async function patch(name: string, body: Record<string, unknown>) {
    if (!selected) return;
    setBusy(name);
    try {
      const data = await send(
        "PATCH",
        `/api/users?id=${encodeURIComponent(selected.id)}`,
        body,
      );
      if (!data) return;
      const account = data.account as Account | null;
      // Keep anything typed into the form, except what this changed.
      if (name === "save" && account) setEditDraft(toDraft(account));
      if (name === "extend" && account) {
        setEditDraft((d) => d && { ...d, expires: dateInput(account.expiresAt) });
      }
      if (name === "add" && account) {
        setAddAmount("");
        setEditDraft((d) => d && { ...d, tokens: amountText(account.limits.tokens) });
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!editDraft || !selected) return;
    const parsed = fromDraft(editDraft, { account: true });
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    const pending = !selected.account?.activatedAt;
    await patch("save", { ...parsed.body, ...(pending ? { activate: true } : {}) });
  }

  async function handleAddTokens() {
    const n = parseAmount(addAmount);
    if (!n || Number.isNaN(n)) {
      setError("Type how many tokens to add, like 1M or 500k.");
      return;
    }
    await patch("add", { addTokens: n });
  }

  async function keyAction(k: UserKey, action: "toggle" | "delete") {
    if (
      action === "delete" &&
      !confirm(`Delete “${k.name}”? Anything using it stops working at once.`)
    )
      return;
    setBusy(k.id);
    try {
      const url = `/api/tokens?id=${encodeURIComponent(k.id)}`;
      const ok =
        action === "delete"
          ? await send("DELETE", url)
          : await send("PATCH", url, { disabled: !k.disabled });
      if (ok) await load();
    } finally {
      setBusy(null);
    }
  }

  const account = selected?.account ?? null;
  const pending = !account?.activatedAt;
  const today = new Date(loadedAt || 0).toISOString().slice(0, 10);
  const detailFresh = detail?.user.id === selectedId ? detail : null;

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Users</span>
          <span className={styles.headerActions}>
            {users && (
              <span className={styles.badge}>
                {users.filter((u) => u.account?.status === "active").length}{" "}
                active · {users.filter((u) => !u.account?.activatedAt).length}{" "}
                waiting
              </span>
            )}
          </span>
        </div>
        <p className={styles.sectionDesc}>
          People sign up at <code>{signUpUrl}</code> and wait there until you
          activate them with a plan: their limits, expiry and providers. Their
          keys, which they make themselves, all share that plan, and its usage
          stays when they delete a key.
        </p>
        <div className={styles.quickActions}>
          <CopyButton value={signUpUrl} label="Copy the sign-up link" />
        </div>

        {loadError && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {loadError}
          </div>
        )}

        {users && users.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Status</th>
                  <th>Tokens</th>
                  <th>Requests</th>
                  <th>Keys</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const a = u.account;
                  const status: KeyStatus = a?.status ?? "pending";
                  const badge = STATUS_BADGES[status];
                  const when = a ? PERIOD_USED[a.limits.period] : "";
                  return (
                    <tr
                      key={u.id}
                      className={u.id === selectedId ? styles.rowSelected : ""}
                    >
                      <td>
                        <div className={styles.strong}>{u.email}</div>
                        <div className={styles.cellNote}>
                          Joined {new Date(u.createdAt).toLocaleDateString()}
                          {u.admin && " · admin"}
                          {!u.emailConfirmed && " · email not confirmed"}
                        </div>
                        {a?.note && (
                          <div className={styles.cellNote} title={a.note}>
                            {a.note.length > 60 ? `${a.note.slice(0, 60)}…` : a.note}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`${styles.badge} ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td>
                        {a?.activatedAt ? (
                          <UsageCell used={a.used.tokens} limit={a.limits.tokens} note={when} />
                        ) : (
                          <span className={styles.dim}>—</span>
                        )}
                      </td>
                      <td>
                        {a?.activatedAt ? (
                          <UsageCell
                            used={a.used.requests - a.used.errors}
                            limit={a.limits.requests}
                            note={when}
                          />
                        ) : (
                          <span className={styles.dim}>—</span>
                        )}
                      </td>
                      <td className={styles.dim}>
                        {a ? `${a.keyCount} of ${a.maxKeys}` : "—"}
                      </td>
                      <td>{a?.activatedAt ? expiryCell(a.expiresAt, loadedAt) : <span className={styles.dim}>—</span>}</td>
                      <td className={styles.dim}>{ago(a?.lastUsedAt ?? null, loadedAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          onClick={() => select(u.id === selectedId ? null : u)}
                        >
                          {u.id === selectedId ? "Close" : "Manage"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {users && users.length === 0 && (
          <p className={styles.empty}>
            Nobody has signed up yet. Send people the sign-up link.
          </p>
        )}
      </section>

      {selected && editDraft && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>
              {selected.email}
              {selected.admin && (
                <span className={`${styles.badge} ${styles.badgeAccent}`} style={{ marginLeft: 8 }}>
                  Admin
                </span>
              )}
            </span>
            <span
              className={`${styles.badge} ${STATUS_BADGES[account?.status ?? "pending"].className}`}
            >
              {STATUS_BADGES[account?.status ?? "pending"].label}
            </span>
          </div>
          <p className={styles.sectionDesc}>
            Joined {new Date(selected.createdAt).toLocaleDateString()},{" "}
            {selected.lastSignInAt
              ? `last signed in ${ago(selected.lastSignInAt, loadedAt).toLowerCase()}`
              : "never signed in"}
            .{" "}
            {pending
              ? "Set what this account may use, then save to activate it: until then its keys don't work."
              : `${limitsText(account!)}. Used ${account!.total.tokens.toLocaleString()} tokens and ${(account!.total.requests - account!.total.errors).toLocaleString()} requests in all.`}
            {!selected.emailConfirmed &&
              " Their email address isn't confirmed, so they can't sign in yet."}
          </p>

          {error && (
            <div className={styles.alert} style={{ marginBottom: 16 }}>
              {error}
            </div>
          )}

          <div className={styles.quickActions}>
            {!pending && account && (
              <button
                type="button"
                className={styles.buttonGhost}
                disabled={busy !== null}
                onClick={() => patch("toggle", { disabled: !account.disabled })}
              >
                {account.disabled ? "Turn on" : "Turn off"}
              </button>
            )}
            {!pending && account?.expiresAt && (
              <button
                type="button"
                className={styles.buttonGhost}
                disabled={busy !== null}
                onClick={() => patch("extend", { extendDays: 30 })}
              >
                +30 days
              </button>
            )}
            {!pending && account && account.limits.tokens !== null && (
              <span className={styles.inlineAmount}>
                <input
                  className={styles.input}
                  value={addAmount}
                  onChange={(e) => setAddAmount(e.target.value)}
                  placeholder="e.g. 1M"
                  aria-label="Tokens to add"
                  inputMode="decimal"
                />
                <button
                  type="button"
                  className={styles.buttonGhost}
                  disabled={busy !== null}
                  onClick={handleAddTokens}
                >
                  Add tokens
                </button>
              </span>
            )}
            {!selected.emailConfirmed && (
              <button
                type="button"
                className={styles.buttonGhost}
                disabled={busy !== null}
                onClick={() => patch("confirm", { confirmEmail: true })}
              >
                Confirm their email
              </button>
            )}
          </div>

          <form onSubmit={handleSave} className={styles.keyPanel}>
            <KeyFields
              id={`user-${selected.id}`}
              draft={editDraft}
              setDraft={setEditDraft}
              providers={providers}
              account
            />
            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => setEditDraft(toDraft(account ?? NEW_PLAN))}
              >
                Undo changes
              </button>
              <button
                type="submit"
                className={styles.button}
                disabled={busy !== null}
              >
                {busy === "save"
                  ? "Saving…"
                  : pending
                    ? "Save and activate"
                    : "Save changes"}
              </button>
            </div>
          </form>

          <div className={styles.sectionHeader} style={{ marginTop: 8 }}>
            <span className={styles.sectionTitle}>Their keys</span>
          </div>
          {detailFresh && detailFresh.keys.length > 0 ? (
            <div className={styles.tableWrap} style={{ marginBottom: 20, marginTop: 8 }}>
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
                  {detailFresh.keys.map((k) => (
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
                          onClick={() => keyAction(k, "toggle")}
                        >
                          {k.disabled ? "Turn on" : "Turn off"}
                        </button>{" "}
                        <button
                          type="button"
                          className={styles.buttonDanger}
                          disabled={busy !== null}
                          onClick={() => keyAction(k, "delete")}
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
            <p className={styles.empty}>{detailFresh ? "No keys yet." : "Loading…"}</p>
          )}

          {account && (
            <UsagePanel
              usage={detailFresh?.usage?.month === detailMonth ? detailFresh.usage : null}
              month={detailMonth}
              months={detailFresh?.months ?? []}
              onMonth={setDetailMonth}
              labels={labels}
              today={today}
            />
          )}
        </section>
      )}
    </>
  );
}
