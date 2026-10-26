"use client";

// The console's Redeem codes page: make plan codes (they activate or renew an
// account) and top-up codes (they add to an active plan) to sell or give
// away, and see which have been used, and by whom. People redeem them on
// /account.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  fromDraft,
  KeyFields,
  parseAmount,
  toDraft,
  type Draft,
  type ProviderOption,
} from "./api-keys";
import styles from "./page.module.css";
import { CopyButton } from "./ui";

type CodeStatus = "unused" | "partly used" | "used" | "expired" | "disabled";

type Code = {
  id: string;
  code: string;
  kind: "plan" | "topup";
  maxUses: number;
  redemptions: { userId: string; email: string; at: string }[];
  expiresAt: string | null;
  disabled: boolean;
  note: string;
  createdAt: string;
  batch: string;
  status: CodeStatus;
  gives: string;
};

const STATUS_BADGES: Record<CodeStatus, { label: string; className: string }> = {
  unused: { label: "Unused", className: styles.badgeSuccess },
  "partly used": { label: "Partly used", className: styles.badgeAccent },
  used: { label: "Used", className: "" },
  expired: { label: "Expired", className: styles.badgeDanger },
  disabled: { label: "Off", className: "" },
};

type Filter = "all" | "unused" | "used" | "off";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All codes" },
  { id: "unused", label: "Can still be used" },
  { id: "used", label: "Used up" },
  { id: "off", label: "Off or expired" },
];

function shown(c: Code, filter: Filter): boolean {
  if (filter === "unused") return c.status === "unused" || c.status === "partly used";
  if (filter === "used") return c.status === "used";
  if (filter === "off") return c.status === "disabled" || c.status === "expired";
  return true;
}

// The plan a new plan code starts from: a month, no limits yet.
const NEW_PLAN = toDraft({
  note: "",
  limits: { period: "month", tokens: null, requests: null, perMinute: null },
  expiresAt: null,
  providers: null,
  agentTools: false,
  maxKeys: 5,
});

// <input type="date"> → the end of that day in this browser's time zone.
function endOfDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

export function Codes({ providers }: { providers: ProviderOption[] }) {
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [redeemUrl, setRedeemUrl] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<"plan" | "topup">("plan");
  const [plan, setPlan] = useState<Draft>({ ...NEW_PLAN, days: "30" });
  const [topup, setTopup] = useState({ tokens: "", requests: "", days: "" });
  const [count, setCount] = useState("1");
  const [maxUses, setMaxUses] = useState("1");
  const [codeExpires, setCodeExpires] = useState("");
  const [ownCode, setOwnCode] = useState("");
  const [note, setNote] = useState("");
  const [made, setMade] = useState<Code[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/codes", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || `Couldn't load the codes (HTTP ${res.status})`);
        return;
      }
      setCodes(data.codes);
      setRedeemUrl(data.redeemUrl);
      setLoadError(null);
    } catch {
      setLoadError("Network error reaching /api/codes");
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
      setError("Network error reaching /api/codes");
      return null;
    }
  }

  // The request body for the form, or why it can't be sent.
  function body(): Record<string, unknown> | string {
    const howMany = Number(count);
    const uses = Number(maxUses);
    if (!Number.isInteger(howMany) || howMany < 1 || howMany > 500) return "Number of codes: 1 to 500.";
    if (!Number.isInteger(uses) || uses < 1) return "Uses per code: 1 or more.";
    const common = {
      kind,
      count: howMany,
      maxUses: uses,
      expiresAt: codeExpires ? endOfDay(codeExpires) : null,
      ...(ownCode.trim() && howMany === 1 ? { code: ownCode.trim() } : {}),
    };
    if (kind === "plan") {
      const parsed = fromDraft(plan, { account: true });
      if ("error" in parsed) return parsed.error;
      const days = plan.days.trim() ? Number(plan.days) : null;
      if (days !== null && (!Number.isInteger(days) || days < 1)) return "Lasts: a whole number of days, or empty for no end.";
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { expiresAt: _planEnd, ...planFields } = parsed.body;
      return { ...common, ...planFields, days };
    }
    const amounts: Record<string, number | null> = {};
    for (const [field, text, label] of [
      ["addTokens", topup.tokens, "Tokens"],
      ["addRequests", topup.requests, "Requests"],
      ["addDays", topup.days, "Days"],
    ] as const) {
      const n = parseAmount(text);
      if (Number.isNaN(n)) return `${label}: type a number, like 1M or 500k, or leave it empty.`;
      amounts[field] = n;
    }
    if (!amounts.addTokens && !amounts.addRequests && !amounts.addDays) {
      return "A top-up needs tokens, requests or days to add.";
    }
    return { ...common, ...amounts, note };
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const b = body();
    if (typeof b === "string") {
      setError(b);
      return;
    }
    setBusy("create");
    try {
      const data = await send("POST", "/api/codes", b);
      if (!data) return;
      setMade(data.codes as Code[]);
      setCreating(false);
      setOwnCode("");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function toggle(c: Code) {
    setBusy(c.id);
    try {
      if (await send("PATCH", `/api/codes?id=${encodeURIComponent(c.id)}`, { disabled: !c.disabled })) await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: Code) {
    if (
      !confirm(
        c.redemptions.length
          ? `Delete ${c.code}? What it gave the accounts that used it stays.`
          : `Delete ${c.code}? Nobody will be able to use it.`,
      )
    )
      return;
    setBusy(c.id);
    try {
      if (await send("DELETE", `/api/codes?id=${encodeURIComponent(c.id)}`)) await load();
    } finally {
      setBusy(null);
    }
  }

  const visible = (codes ?? []).filter((c) => shown(c, filter));
  const usable = (codes ?? []).filter((c) => c.status === "unused").map((c) => c.code);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Redeem codes</span>
        <span className={styles.headerActions}>
          {codes && (
            <span className={styles.badge}>
              {usable.length} unused of {codes.length}
            </span>
          )}
          <button
            type="button"
            className={creating ? styles.buttonGhost : styles.button}
            onClick={() => {
              setCreating(!creating);
              setError(null);
            }}
          >
            {creating ? "Cancel" : "New codes"}
          </button>
        </span>
      </div>
      <p className={styles.sectionDesc}>
        Sell or give these instead of activating people by hand. They redeem
        them at <code>{redeemUrl || "/account"}</code>. A <strong>plan</strong>{" "}
        code activates an account with its plan, or replaces the plan and
        renews it (its days count from the end of the current one). A{" "}
        <strong>top-up</strong> adds tokens, requests or days to an active plan.
        On a daily or monthly plan, added tokens raise every period&apos;s
        allowance, so sell top-ups with prepaid (in total) plans. Each account
        can use a code once.
      </p>

      {creating && (
        <form onSubmit={handleCreate} className={styles.keyPanel}>
          <div className={styles.field} style={{ marginBottom: 14 }}>
            <label className={styles.label} htmlFor="code-kind">
              Kind
            </label>
            <select
              id="code-kind"
              className={styles.select}
              value={kind}
              onChange={(e) => setKind(e.target.value as "plan" | "topup")}
            >
              <option value="plan">Plan: activates or renews an account</option>
              <option value="topup">Top-up: adds to an active plan</option>
            </select>
          </div>

          {kind === "plan" ? (
            <KeyFields
              id="code-plan"
              draft={plan}
              setDraft={setPlan}
              providers={providers}
              account
              lasts
            />
          ) : (
            <div className={styles.keyForm}>
              <div className={styles.fourCol}>
                {(
                  [
                    ["tokens", "Tokens to add", "e.g. 1M"],
                    ["requests", "Requests to add", "e.g. 500"],
                    ["days", "Days to add", "e.g. 30"],
                  ] as const
                ).map(([field, label, placeholder]) => (
                  <div key={field} className={styles.field}>
                    <label className={styles.label} htmlFor={`topup-${field}`}>
                      {label}
                    </label>
                    <input
                      id={`topup-${field}`}
                      className={styles.input}
                      inputMode="decimal"
                      value={topup[field]}
                      onChange={(e) => setTopup({ ...topup, [field]: e.target.value })}
                      placeholder={placeholder}
                    />
                  </div>
                ))}
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="topup-note">
                    Note (only you see it)
                  </label>
                  <input
                    id="topup-note"
                    className={styles.input}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={1000}
                  />
                </div>
              </div>
              <p className={styles.fieldHint}>
                Only what the plan has a limit or end date for is added.
              </p>
            </div>
          )}

          <div className={styles.fourCol} style={{ marginTop: 16 }}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="code-count">
                Number of codes
              </label>
              <input
                id="code-count"
                className={styles.input}
                inputMode="numeric"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="code-uses">
                Uses per code
              </label>
              <input
                id="code-uses"
                className={styles.input}
                inputMode="numeric"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="code-expires">
                Code expires
              </label>
              <input
                id="code-expires"
                type="date"
                className={styles.input}
                value={codeExpires}
                onChange={(e) => setCodeExpires(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="code-own">
                Your own code
              </label>
              <input
                id="code-own"
                className={`${styles.input} ${styles.mono}`}
                value={ownCode}
                onChange={(e) => setOwnCode(e.target.value)}
                placeholder={Number(count) === 1 ? "Empty: a random one" : "Only for 1 code"}
                disabled={Number(count) !== 1}
                maxLength={40}
              />
            </div>
          </div>
          <p className={styles.fieldHint} style={{ marginTop: 8 }}>
            Uses per code: how many different accounts can use each one (1 for a
            code you sell; more for a promotion). Random codes look like
            K7QM-2XHD-9WPB; your own text is easier to guess, so keep it for
            promotions.
          </p>
          <div className={styles.formActions}>
            <button type="submit" className={styles.button} disabled={busy !== null}>
              {busy === "create"
                ? "Making…"
                : `Make ${Number(count) > 1 ? `${count} codes` : "the code"}`}
            </button>
          </div>
        </form>
      )}

      {(error || loadError) && (
        <div className={styles.alert} style={{ marginBottom: 16 }}>
          {error || loadError}
        </div>
      )}

      {made && made.length > 0 && (
        <div className={styles.reveal}>
          <div className={styles.revealLabel}>
            Made {made.length} {made.length === 1 ? "code" : "codes"}: {made[0].gives}.
            They stay in the list below, so you can copy them again later.
          </div>
          <div className={styles.revealRow}>
            <span className={styles.revealValue}>
              {made.slice(0, 5).map((c) => c.code).join("  ")}
              {made.length > 5 ? `  … and ${made.length - 5} more` : ""}
            </span>
            <CopyButton value={made.map((c) => c.code).join("\n")} label={made.length > 1 ? "Copy all" : "Copy"} />
            <button type="button" className={styles.buttonGhost} onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {codes && codes.length > 0 && (
        <div className={styles.quickActions}>
          <select
            className={`${styles.select} ${styles.selectCompact}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            aria-label="Show"
          >
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {usable.length > 0 && <CopyButton value={usable.join("\n")} label={`Copy ${usable.length} unused`} />}
          <CopyButton value={redeemUrl} label="Copy the redeem link" />
        </div>
      )}

      {visible.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Gives</th>
                <th>Used</th>
                <th>Status</th>
                <th>Code expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const badge = STATUS_BADGES[c.status];
                const who = c.redemptions.map((r) => r.email);
                return (
                  <tr key={c.id}>
                    <td>
                      <div className={`${styles.mono} ${styles.strong}`}>{c.code}</div>
                      <div className={styles.cellNote}>
                        Made {new Date(c.createdAt).toLocaleDateString()}
                        {c.note && ` · ${c.note.length > 50 ? `${c.note.slice(0, 50)}…` : c.note}`}
                      </div>
                    </td>
                    <td>{c.gives}</td>
                    <td>
                      <div>
                        {c.redemptions.length} of {c.maxUses}
                      </div>
                      {who.length > 0 && (
                        <div className={styles.cellNote} title={who.join("\n")}>
                          {who.slice(0, 2).join(", ")}
                          {who.length > 2 ? ` +${who.length - 2}` : ""}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`${styles.badge} ${badge.className}`}>{badge.label}</span>
                    </td>
                    <td className={styles.dim}>
                      {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "Never"}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <CopyButton value={c.code} />{" "}
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        disabled={busy !== null}
                        onClick={() => toggle(c)}
                      >
                        {c.disabled ? "Turn on" : "Turn off"}
                      </button>{" "}
                      <button
                        type="button"
                        className={styles.buttonDanger}
                        disabled={busy !== null}
                        onClick={() => remove(c)}
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
      )}
      {codes && codes.length === 0 && !creating && (
        <p className={styles.empty}>No codes yet. Make some with New codes.</p>
      )}
      {codes && codes.length > 0 && visible.length === 0 && (
        <p className={styles.empty}>No codes match.</p>
      )}
    </section>
  );
}
