"use client";

// The console's API keys page: access tokens for other people and apps, each
// with its own limits, expiry and providers, and their usage.

import { useEffect, useState, type FormEvent } from "react";
import styles from "./page.module.css";
import { CopyButton, formatCount, ProgressBar, UsagePanel, type MonthUsage } from "./ui";

// ---------------------------------------------------------------------------
// Types, as /api/tokens sends them
// ---------------------------------------------------------------------------

type Period = "day" | "month" | "total";

type KeyCounts = {
  requests: number;
  errors: number;
  tokens: number;
  estimatedTokens: number;
};

export type KeyStatus = "active" | "pending" | "disabled" | "expired" | "limited";

export type KeySummary = {
  id: string;
  name: string;
  note: string;
  hint: string;
  createdAt: string;
  status: KeyStatus;
  disabled: boolean;
  expiresAt: string | null;
  limits: {
    period: Period;
    tokens: number | null;
    requests: number | null;
    perMinute: number | null;
  };
  providers: string[] | null;
  agentTools: boolean;
  lastUsedAt: string | null;
  used: KeyCounts; // in the current period
  remaining: { tokens: number | null; requests: number | null };
  resetsAt: string | null;
  total: KeyCounts;
};

type KeyDetail = {
  token: KeySummary;
  usage: MonthUsage;
  months: string[];
};

export type ProviderOption = { id: string; label: string };

const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: "month", label: "Per month" },
  { id: "day", label: "Per day" },
  { id: "total", label: "In total (prepaid)" },
];

const PERIOD_USED: Record<Period, string> = {
  day: "today",
  month: "this month",
  total: "in total",
};

export const STATUS_BADGES: Record<
  KeyStatus,
  { label: string; className: string }
> = {
  active: { label: "Active", className: styles.badgeSuccess },
  pending: { label: "Waiting", className: styles.badgeAccent },
  disabled: { label: "Off", className: "" },
  expired: { label: "Expired", className: styles.badgeDanger },
  limited: { label: "Used up", className: styles.badgeWarning },
};

// ---------------------------------------------------------------------------
// The key form
// ---------------------------------------------------------------------------

// CLIs that can't answer without their tools: a key needs agent access for
// them (lib/auth.ts keyRule).
export const TOOL_ONLY = ["gemini", "antigravity"];

// Its fields, as typed.
export type Draft = {
  name: string;
  maxKeys: string; // accounts only
  note: string;
  period: Period;
  tokens: string; // "1M", "500k", "250000"; empty for no limit
  requests: string;
  perMinute: string;
  expires: string; // a date in this browser's time zone; empty for never
  days: string; // redeem codes: how long the plan lasts; empty for no end
  allProviders: boolean;
  providers: string[];
  agentTools: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  maxKeys: "5",
  note: "",
  period: "month",
  tokens: "",
  requests: "",
  perMinute: "",
  expires: "",
  days: "",
  allProviders: true,
  providers: [],
  agentTools: false,
};

// "1M" → 1000000, "2.5k" → 2500, "" → null (no limit); NaN for anything else.
export function parseAmount(text: string): number | null {
  const t = text.trim().replace(/[,_\s]/g, "");
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(t);
  if (!m) return NaN;
  const scale = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[
    m[2].toLowerCase() as "" | "k" | "m" | "b"
  ];
  return Math.round(Number(m[1]) * scale);
}

export function amountText(n: number | null): string {
  if (n === null) return "";
  if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}k`;
  return String(n);
}

// <input type="date"> is in this browser's time zone, and a key set to
// expire on a day works to the end of that day here.
export function dateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function endOfDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

// What a form can be filled from: a key, or an account (no name, but a
// number of keys).
type DraftSource = Pick<
  KeySummary,
  "note" | "limits" | "expiresAt" | "providers" | "agentTools"
> & { name?: string; maxKeys?: number };

export function toDraft(k: DraftSource): Draft {
  return {
    name: k.name ?? "",
    maxKeys: String(k.maxKeys ?? 5),
    note: k.note,
    period: k.limits.period,
    tokens: amountText(k.limits.tokens),
    requests: amountText(k.limits.requests),
    perMinute: amountText(k.limits.perMinute),
    expires: dateInput(k.expiresAt),
    days: "",
    allProviders: k.providers === null,
    providers: k.providers ?? [],
    agentTools: k.agentTools,
  };
}

// The request body for a draft, or why it can't be sent.
export function fromDraft(
  d: Draft,
  { account = false }: { account?: boolean } = {},
): { body: Record<string, unknown> } | { error: string } {
  const limits: Record<string, number | null> = {};
  const fields = [
    ["tokens", "Tokens"],
    ["requests", "Requests"],
    ["perMinute", "Requests a minute"],
  ] as const;
  for (const [field, label] of fields) {
    const n = parseAmount(d[field]);
    if (Number.isNaN(n)) {
      return {
        error: `${label}: type a number, like 1M or 500k, or leave it empty for no limit.`,
      };
    }
    limits[field] = n;
  }
  if (!d.allProviders && d.providers.length === 0) {
    return { error: "Pick at least one provider, or allow them all." };
  }
  const maxKeys = Number(d.maxKeys);
  if (account && (!Number.isInteger(maxKeys) || maxKeys < 0 || maxKeys > 100)) {
    return { error: "Max keys: a whole number from 0 to 100." };
  }
  return {
    body: {
      ...(account ? { maxKeys } : { name: d.name }),
      note: d.note,
      limits: { period: d.period, ...limits },
      expiresAt: d.expires ? endOfDay(d.expires) : null,
      providers: d.allProviders ? null : d.providers,
      agentTools: d.agentTools,
    },
  };
}

// `account`: an account's plan, which has no name but a number of keys.
// `lasts`: a redeem code's plan, which lasts some days from redeeming
// instead of ending on a date.
export function KeyFields({
  id,
  draft,
  setDraft,
  providers,
  account = false,
  lasts = false,
}: {
  id: string;
  draft: Draft;
  setDraft: (d: Draft) => void;
  providers: ProviderOption[];
  account?: boolean;
  lasts?: boolean;
}) {
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft({ ...draft, [field]: value });
  const toolOnly = providers
    .filter((p) => TOOL_ONLY.includes(p.id) && draft.providers.includes(p.id))
    .map((p) => p.label);
  const amount = (
    field: "tokens" | "requests" | "perMinute",
    label: string,
    placeholder: string,
  ) => (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={`${id}-${field}`}>
        {label}
      </label>
      <input
        id={`${id}-${field}`}
        className={styles.input}
        inputMode="decimal"
        value={draft[field]}
        onChange={(e) => set(field, e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <div className={styles.keyForm}>
      <div className={styles.twoCol}>
        {account ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-max-keys`}>
              Max keys
            </label>
            <input
              id={`${id}-max-keys`}
              className={styles.input}
              inputMode="numeric"
              value={draft.maxKeys}
              onChange={(e) => set("maxKeys", e.target.value)}
            />
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-name`}>
              Name
            </label>
            <input
              id={`${id}-name`}
              className={styles.input}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Who or what it's for"
              maxLength={100}
            />
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-note`}>
            Note (only you see it)
          </label>
          <input
            id={`${id}-note`}
            className={styles.input}
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder="Contact, plan, payment…"
            maxLength={1000}
          />
        </div>
      </div>

      <div className={styles.fourCol}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-period`}>
            Limits count
          </label>
          <select
            id={`${id}-period`}
            className={styles.select}
            value={draft.period}
            onChange={(e) => set("period", e.target.value as Period)}
          >
            {PERIOD_OPTIONS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {amount("tokens", "Tokens", "No limit, or e.g. 1M")}
        {amount("requests", "Requests", "No limit, or e.g. 500")}
        {amount("perMinute", "Requests a minute", "No limit, or e.g. 20")}
      </div>
      <p className={styles.fieldHint}>
        Days and months are UTC. Failed requests don&apos;t count. In total
        means a prepaid amount: add more to it with Add tokens.
        {account && " Every key of the account shares these."}
      </p>

      <div className={styles.twoCol}>
        {lasts ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-days`}>
              Lasts (days)
            </label>
            <input
              id={`${id}-days`}
              className={styles.input}
              inputMode="numeric"
              value={draft.days}
              onChange={(e) => set("days", e.target.value)}
              placeholder="No end, or e.g. 30"
            />
            <span className={styles.fieldHint}>
              From redeeming, or from the end of the plan it renews.
            </span>
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-expires`}>
              Expires
            </label>
            <input
              id={`${id}-expires`}
              type="date"
              className={styles.input}
              value={draft.expires}
              onChange={(e) => set("expires", e.target.value)}
            />
            <span className={styles.fieldHint}>
              Empty: never. It works to the end of that day.
            </span>
          </div>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Providers</span>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            className={styles.switch}
            checked={draft.allProviders}
            onChange={(e) => set("allProviders", e.target.checked)}
          />
          <span>All of them, including ones added later</span>
        </label>
        {!draft.allProviders && (
          <div className={styles.checkChips}>
            {providers.map((p) => (
              <label key={p.id} className={styles.checkChip}>
                <input
                  type="checkbox"
                  checked={draft.providers.includes(p.id)}
                  onChange={(e) =>
                    set(
                      "providers",
                      e.target.checked
                        ? [...draft.providers, p.id]
                        : draft.providers.filter((x) => x !== p.id),
                    )
                  }
                />
                {p.label}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Agent access</span>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            className={styles.switch}
            checked={draft.agentTools}
            onChange={(e) => set("agentTools", e.target.checked)}
          />
          <span>Let the coding CLIs use their tools on this machine</span>
        </label>
        <span className={styles.fieldHint}>
          On: Claude Code, Codex, Gemini CLI and Antigravity can read files here,
          in a folder the caller picks (this gateway&apos;s .env with every API
          key included), and the key can generate images. Off: Claude Code and
          Codex answer without tools, and the others are refused. Leave it off
          for keys you give to other people.
        </span>
        {!draft.agentTools && !draft.allProviders && toolOnly.length > 0 && (
          <span className={styles.warningText} style={{ fontSize: "0.78rem" }}>
            {toolOnly.join(" and ")} only{" "}
            {toolOnly.length > 1 ? "run" : "runs"} with agent access, so this
            key can&apos;t use {toolOnly.length > 1 ? "them" : "it"}.
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function limitsText(k: Pick<KeySummary, "limits" | "expiresAt">): string {
  const { period, tokens, requests, perMinute } = k.limits;
  const amounts = [
    tokens !== null ? `${tokens.toLocaleString()} tokens` : null,
    requests !== null ? `${requests.toLocaleString()} requests` : null,
  ].filter(Boolean);
  const per = period === "total" ? "in total" : `a ${period}`;
  const parts = [amounts.length ? `${amounts.join(" and ")} ${per}` : "No limit"];
  if (perMinute !== null) parts.push(`up to ${perMinute.toLocaleString()} requests a minute`);
  if (k.expiresAt) parts.push(`until ${new Date(k.expiresAt).toLocaleString()}`);
  return parts.join(", ");
}

// What to send the key's holder.
function holderMessage(
  k: KeySummary,
  secret: string,
  base: string,
  labels: Map<string, string>,
): string {
  return [
    `Your API key: ${secret}`,
    `Address: ${base}`,
    `Limits: ${limitsText(k)}`,
    `Providers: ${k.providers ? k.providers.map((p) => labels.get(p) ?? p).join(", ") : "all of them"}`,
    `How to call it: ${base}/documents`,
    `What you have left: curl ${base}/api/me -H "Authorization: Bearer ${secret}"`,
    "Keep the key to yourself: anyone who has it can use what's left on it.",
  ].join("\n");
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "Never";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function expiryCell(iso: string | null, now: number) {
  if (!iso) return <span className={styles.dim}>Never</span>;
  const left = Date.parse(iso) - now;
  const date = new Date(iso).toLocaleDateString();
  if (left <= 0) return <span className={styles.dangerText}>{date}</span>;
  if (left < 3 * 86_400_000) {
    return (
      <span className={styles.warningText}>
        {date} (in {Math.max(1, Math.round(left / 3_600_000))}h)
      </span>
    );
  }
  return date;
}

export function UsageCell({
  used,
  limit,
  note,
}: {
  used: number;
  limit: number | null;
  note: string;
}) {
  return (
    <div>
      {limit === null ? (
        <span>{formatCount(used)}</span>
      ) : (
        <ProgressBar used={used} limit={limit} />
      )}
      <div className={styles.cellNote}>{note}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function ApiKeys({
  keys,
  publicOrigin,
  providers,
  reload,
  now,
}: {
  keys: KeySummary[] | null;
  publicOrigin: string | null;
  providers: ProviderOption[];
  reload: () => Promise<void>;
  now: number; // when `keys` was loaded
}) {
  const [origin] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{
    secret: string;
    key: KeySummary;
    rotated: boolean;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const [addAmount, setAddAmount] = useState("");
  const [detailMonth, setDetailMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [detail, setDetail] = useState<KeyDetail | null>(null);

  const labels = new Map(providers.map((p) => [p.id, p.label]));
  const selected = keys?.find((k) => k.id === selectedId) ?? null;
  const activeCount = keys?.filter((k) => k.status === "active").length ?? 0;
  const base = publicOrigin ?? origin;

  // The selected key's month, again whenever the list is refreshed.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch(
          `/api/tokens?id=${encodeURIComponent(selectedId!)}&month=${detailMonth}`,
        );
        if (!res.ok) return;
        const data: KeyDetail = await res.json();
        if (!cancelled) setDetail(data);
      } catch {
        // network hiccup — keep showing the last numbers
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailMonth, keys]);

  async function send(
    method: "POST" | "PATCH" | "DELETE",
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
      setError("Network error reaching /api/tokens");
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

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const parsed = fromDraft(draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    await act("create", async () => {
      const data = await send("POST", "/api/tokens", parsed.body);
      if (!data) return;
      const { token: secret, ...key } = data as KeySummary & { token: string };
      setRevealed({ secret, key, rotated: false });
      setDraft(EMPTY_DRAFT);
      setCreating(false);
      await reload();
    });
  }

  function select(k: KeySummary | null) {
    setSelectedId(k?.id ?? null);
    setEditDraft(k ? toDraft(k) : null);
    setDetail(null);
    setAddAmount("");
    setError(null);
  }

  async function patch(name: string, body: Record<string, unknown>) {
    if (!selected) return;
    await act(name, async () => {
      const data = await send(
        "PATCH",
        `/api/tokens?id=${encodeURIComponent(selected.id)}`,
        body,
      );
      if (!data) return;
      const { token: secret, ...key } = data as KeySummary & { token?: string };
      if (secret) setRevealed({ secret, key, rotated: true });
      // Keep anything typed into the form, except what this changed.
      if (name === "save") setEditDraft(toDraft(key));
      if (name === "extend") {
        setEditDraft((d) => d && { ...d, expires: dateInput(key.expiresAt) });
      }
      if (name === "add") {
        setAddAmount("");
        setEditDraft((d) => d && { ...d, tokens: amountText(key.limits.tokens) });
      }
      await reload();
    });
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!editDraft) return;
    const parsed = fromDraft(editDraft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    await patch("save", parsed.body);
  }

  async function handleAddTokens() {
    const n = parseAmount(addAmount);
    if (!n || Number.isNaN(n)) {
      setError("Type how many tokens to add, like 1M or 500k.");
      return;
    }
    await patch("add", { addTokens: n });
  }

  async function handleRotate() {
    if (
      !selected ||
      !confirm(
        `Make a new key for “${selected.name}”? The current one stops working at once. Its limits and usage stay.`,
      )
    )
      return;
    await patch("rotate", { rotate: true });
  }

  async function handleDelete() {
    if (
      !selected ||
      !confirm(
        `Delete “${selected.name}”? Anything using it stops working at once, and its usage history goes with it.`,
      )
    )
      return;
    await act("delete", async () => {
      const data = await send(
        "DELETE",
        `/api/tokens?id=${encodeURIComponent(selected.id)}`,
      );
      if (!data) return;
      select(null);
      await reload();
    });
  }

  const todayUtc = new Date(now || 0).toISOString().slice(0, 10);
  const usage = detail?.token.id === selectedId ? detail.usage : null;

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Access tokens</span>
          <span className={styles.headerActions}>
            <span className={styles.badge}>{activeCount} active</span>
            <button
              type="button"
              className={creating ? styles.buttonGhost : styles.button}
              onClick={() => {
                setCreating(!creating);
                setError(null);
              }}
            >
              {creating ? "Cancel" : "New key"}
            </button>
          </span>
        </div>
        <p className={styles.sectionDesc}>
          Keys for other people and apps, instead of your APP_API_KEY. Each has
          its own limits, expiry and providers, and its own usage: tokens as the
          provider reports them, or estimated from the text where it
          doesn&apos;t (the web chats, Codex, Gemini CLI). A key can call{" "}
          <code>/api/chat</code>, <code>/api/chat/stream</code>,{" "}
          <code>/api/image</code>, <code>/api/transcribe</code>,{" "}
          <code>/api/speech</code>, <code>/api/models</code> and{" "}
          <code>/api/me</code>, where its holder sees what&apos;s left.
        </p>

        {creating && (
          <form onSubmit={handleCreate} className={styles.keyPanel}>
            <KeyFields
              id="new-key"
              draft={draft}
              setDraft={setDraft}
              providers={providers}
            />
            <div className={styles.formActions}>
              <button
                type="submit"
                className={styles.button}
                disabled={busy === "create"}
              >
                {busy === "create" ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {revealed && (
          <div className={styles.reveal}>
            <div className={styles.revealLabel}>
              {revealed.rotated
                ? `New key for “${revealed.key.name}”: the old one has stopped working. Copy it now — it won't be shown again.`
                : `Key for “${revealed.key.name}”. Copy it now — it won't be shown again.`}
            </div>
            <div className={styles.revealRow}>
              <span className={styles.revealValue}>{revealed.secret}</span>
              <CopyButton value={revealed.secret} />
              <CopyButton
                label="Copy message"
                value={holderMessage(revealed.key, revealed.secret, base, labels)}
              />
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => setRevealed(null)}
              >
                Done
              </button>
            </div>
            <div className={styles.fieldHint} style={{ marginTop: 8 }}>
              The message has the key, the address ({base}), its limits and
              how to check what&apos;s left, ready to send.
            </div>
          </div>
        )}

        {keys && keys.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Tokens</th>
                  <th>Requests</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const badge = STATUS_BADGES[k.status];
                  const when = PERIOD_USED[k.limits.period];
                  const failed = k.used.errors
                    ? ` · ${k.used.errors.toLocaleString()} failed`
                    : "";
                  return (
                    <tr
                      key={k.id}
                      className={k.id === selectedId ? styles.rowSelected : ""}
                    >
                      <td>
                        <div className={styles.strong}>{k.name}</div>
                        <div className={`${styles.mono} ${styles.cellNote}`}>
                          {k.hint}
                        </div>
                        {k.note && (
                          <div className={styles.cellNote} title={k.note}>
                            {k.note.length > 60
                              ? `${k.note.slice(0, 60)}…`
                              : k.note}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`${styles.badge} ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td>
                        <UsageCell
                          used={k.used.tokens}
                          limit={k.limits.tokens}
                          note={
                            k.used.estimatedTokens
                              ? `${when} · ≈${formatCount(k.used.estimatedTokens)} estimated`
                              : when
                          }
                        />
                      </td>
                      <td>
                        <UsageCell
                          used={k.used.requests - k.used.errors}
                          limit={k.limits.requests}
                          note={`${when}${failed}`}
                        />
                      </td>
                      <td>{expiryCell(k.expiresAt, now)}</td>
                      <td className={styles.dim}>{ago(k.lastUsedAt, now)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          onClick={() => select(k.id === selectedId ? null : k)}
                        >
                          {k.id === selectedId ? "Close" : "Manage"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {keys && keys.length === 0 && !creating && (
          <p className={styles.empty}>
            No keys yet. Make one with New key.
          </p>
        )}
      </section>

      {selected && editDraft && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>
              {selected.name}{" "}
              <span className={`${styles.mono} ${styles.dim}`}>
                {selected.hint}
              </span>
            </span>
            <span
              className={`${styles.badge} ${STATUS_BADGES[selected.status].className}`}
            >
              {STATUS_BADGES[selected.status].label}
            </span>
          </div>
          <p className={styles.sectionDesc}>
            {limitsText(selected)}. Made{" "}
            {new Date(selected.createdAt).toLocaleDateString()}; used{" "}
            {selected.total.tokens.toLocaleString()} tokens and{" "}
            {(selected.total.requests - selected.total.errors).toLocaleString()}{" "}
            requests in all.
            {selected.resetsAt &&
              ` Its ${selected.limits.period === "day" ? "daily" : "monthly"} limits start over on ${new Date(selected.resetsAt).toLocaleString()}.`}
          </p>

          <div className={styles.quickActions}>
            <button
              type="button"
              className={styles.buttonGhost}
              disabled={busy !== null}
              onClick={() => patch("toggle", { disabled: !selected.disabled })}
            >
              {selected.disabled ? "Turn on" : "Turn off"}
            </button>
            {selected.expiresAt && (
              <button
                type="button"
                className={styles.buttonGhost}
                disabled={busy !== null}
                onClick={() => patch("extend", { extendDays: 30 })}
              >
                +30 days
              </button>
            )}
            {selected.limits.tokens !== null && (
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
            <button
              type="button"
              className={styles.buttonGhost}
              disabled={busy !== null}
              onClick={handleRotate}
            >
              New secret
            </button>
            <button
              type="button"
              className={`${styles.buttonGhost} ${styles.buttonStop}`}
              disabled={busy !== null}
              onClick={handleDelete}
            >
              Delete
            </button>
          </div>

          <form onSubmit={handleSave} className={styles.keyPanel}>
            <KeyFields
              id={`key-${selected.id}`}
              draft={editDraft}
              setDraft={setEditDraft}
              providers={providers}
            />
            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => setEditDraft(toDraft(selected))}
              >
                Undo changes
              </button>
              <button
                type="submit"
                className={styles.button}
                disabled={busy !== null}
              >
                {busy === "save" ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>

          <UsagePanel
            usage={usage}
            month={detailMonth}
            months={detail?.months ?? []}
            onMonth={setDetailMonth}
            labels={labels}
            today={todayUtc}
          />
        </section>
      )}
    </>
  );
}
