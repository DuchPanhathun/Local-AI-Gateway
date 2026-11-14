"use client";

// The Manage page's "Provider keys" section: the API keys of the cloud providers (SEA-LION, Cerebras, Groq, Coarena,
// Google AI Studio). Add keys by pasting them, switch any key off or on, and remove the ones added here. The keys in
// the server's .env are listed too, but only switched off or on: a key's value is never sent to the browser, only a
// masked form. A change applies to the next request, with no restart. See /api/provider-keys.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago } from "./api-keys";
import styles from "./page.module.css";
import { CLOUD_PROVIDERS, PROVIDER_LABELS } from "./providers";
import { splitKeys } from "@/lib/key-text";

type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

type KeyInfo = {
  name: string;
  source: "env" | "web";
  id?: string;
  label?: string;
  masked: string;
  disabled: boolean;
  addedAt?: string;
};

type Listed = { provider: CloudProvider; keys: KeyInfo[]; active: number };

type Result = { masked: string; status: "added" | "duplicate" | "invalid" | "rejected" | "limit"; detail: string };

const RESULT_BADGES: Record<Result["status"], { label: string; className: string }> = {
  added: { label: "Added", className: styles.badgeSuccess },
  duplicate: { label: "Already set", className: "" },
  invalid: { label: "Not a key", className: styles.badgeDanger },
  rejected: { label: "Refused", className: styles.badgeDanger },
  limit: { label: "Over the limit", className: styles.badgeWarning },
};

// Keys listed before "Show all".
const SHOWN = 10;

export function ProviderKeys({ onChanged }: { onChanged?: () => void }) {
  const [listed, setListed] = useState<Listed[] | null>(null);
  const [perProvider, setPerProvider] = useState(100);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<CloudProvider>(CLOUD_PROVIDERS[0]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [verify, setVerify] = useState(true);
  const [results, setResults] = useState<Result[] | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/provider-keys", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error || `Couldn't load the keys (HTTP ${res.status})`);
        return;
      }
      setListed(data.providers);
      setPerProvider(data.limits?.perProvider ?? 100);
      setNow(Date.now());
      setLoadError(null);
    } catch {
      setLoadError("Network error reaching /api/provider-keys");
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
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !Array.isArray(data.results)) setError(data.error || `Failed (HTTP ${res.status})`);
      return { ok: res.ok, data };
    } catch {
      setError("Network error reaching /api/provider-keys");
      return { ok: false, data: {} };
    }
  }

  const current = listed?.find((l) => l.provider === provider);
  // The keys added here come first, newest at the top: they are the ones being worked on, and the list is cut short.
  const keys = [
    ...(current?.keys ?? []).filter((k) => k.source === "web").reverse(),
    ...(current?.keys ?? []).filter((k) => k.source === "env"),
  ];
  const providerLabel = PROVIDER_LABELS[provider];

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const pasted = splitKeys(text);
    if (pasted.length === 0) {
      setError("Paste at least one API key.");
      return;
    }
    setBusy("add");
    setResults(null);
    try {
      const { data } = await send("POST", "/api/provider-keys", { provider, keys: text, label, verify });
      if (!Array.isArray(data.results)) return;
      const outcome = data.results as Result[];
      setResults(outcome);
      // What was added or was already there is done with; the rest stays in the box, to fix and send again.
      setText(pasted.filter((_, i) => !["added", "duplicate"].includes(outcome[i]?.status)).join("\n"));
      await load();
      if (outcome.some((r) => r.status === "added")) onChanged?.();
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle(k: KeyInfo) {
    if (busy) return;
    setBusy(k.name);
    try {
      const { ok } = await send("PATCH", "/api/provider-keys", { provider, name: k.name, disabled: !k.disabled });
      if (ok) {
        await load();
        onChanged?.();
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(k: KeyInfo) {
    if (busy || !k.id) return;
    if (!window.confirm(`Remove ${k.masked} from ${providerLabel}? Requests stop using it, and it can't be shown again.`)) return;
    setBusy(k.name);
    try {
      const { ok } = await send("DELETE", `/api/provider-keys?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(k.id)}`);
      if (ok) {
        await load();
        onChanged?.();
      }
    } finally {
      setBusy(null);
    }
  }

  const webCount = keys.filter((k) => k.source === "web").length;
  const visible = showAll ? keys : keys.slice(0, SHOWN);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Provider keys</span>
        {current && (
          <span className={styles.badge}>
            {providerLabel}: {current.active} of {keys.length} on
          </span>
        )}
      </div>
      <p className={styles.sectionDesc}>
        The API keys the cloud providers are called with, taken in turn and skipped when one hits its limit. Paste new
        keys below and they are used from the next request, with no restart. They are kept on the server, readable only
        by the account it runs as, and can&apos;t be shown again: only a masked form is listed. Keys set in the
        server&apos;s <code>.env</code> are listed too; those can be switched off here, but removed only by editing the
        file.
      </p>

      {(error || loadError) && (
        <div className={styles.alert} style={{ marginBottom: 16 }}>
          {error || loadError}
        </div>
      )}

      <div className={styles.field} style={{ marginBottom: 14, maxWidth: 360 }}>
        <label className={styles.label} htmlFor="keys-provider">
          Provider
        </label>
        <select
          id="keys-provider"
          className={styles.select}
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as CloudProvider);
            setShowAll(false);
            setResults(null);
          }}
        >
          {CLOUD_PROVIDERS.map((p) => {
            const l = listed?.find((x) => x.provider === p);
            return (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
                {l ? ` · ${l.active} of ${l.keys.length} keys on` : ""}
              </option>
            );
          })}
        </select>
      </div>

      {listed === null && !loadError ? (
        <p className={styles.dim}>Loading…</p>
      ) : keys.length === 0 ? (
        <p className={styles.dim} style={{ marginBottom: 14 }}>
          {providerLabel} has no API keys yet. Add one below.
        </p>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>From</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((k) => (
                  <tr key={k.name}>
                    <td>
                      <span className={styles.mono}>{k.masked}</span>
                      <div className={`${styles.cellNote} ${styles.mono}`}>{k.label ? `${k.label} · ${k.name}` : k.name}</div>
                    </td>
                    <td className={styles.dim}>{k.source === "env" ? "Server .env" : "Added here"}</td>
                    <td>
                      <span className={`${styles.badge} ${k.disabled ? styles.badgeWarning : styles.badgeSuccess}`}>
                        {k.disabled ? "Off" : "On"}
                      </span>
                    </td>
                    <td className={styles.dim}>{k.addedAt ? ago(k.addedAt, now) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          disabled={busy !== null}
                          onClick={() => handleToggle(k)}
                        >
                          {busy === k.name ? "Saving…" : k.disabled ? "Switch on" : "Switch off"}
                        </button>
                        {k.source === "web" && (
                          <button
                            type="button"
                            className={styles.buttonDanger}
                            disabled={busy !== null}
                            onClick={() => handleRemove(k)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {keys.length > SHOWN && (
            <button
              type="button"
              className={styles.linkButton}
              style={{ margin: "12px 0 14px" }}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? `Show the first ${SHOWN}` : `Show all ${keys.length} keys`}
            </button>
          )}
        </>
      )}

      <form onSubmit={handleAdd} className={styles.keyPanel} style={{ marginTop: 14 }}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="keys-text">
            Add keys to {providerLabel}
          </label>
          <textarea
            id="keys-text"
            className={`${styles.input} ${styles.mono}`}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Paste one key per line, or several separated by spaces or commas.\nLines copied from a .env file work too."}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className={styles.twoCol} style={{ marginTop: 12 }}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="keys-label">
              Label (optional)
            </label>
            <input
              id="keys-label"
              className={styles.input}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              placeholder="e.g. second Google project"
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Check</span>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                className={styles.switch}
                checked={verify}
                onChange={(e) => setVerify(e.target.checked)}
              />
              <span>Ask {providerLabel} whether it takes each key first</span>
            </label>
          </div>
        </div>
        <p className={styles.fieldHint} style={{ marginTop: 8 }}>
          Checking asks the provider for its model list, which costs nothing. A key it refuses is not added, so a typo
          doesn&apos;t get into the rotation. Up to {perProvider} keys can be added here for each provider
          ({webCount} so far for {providerLabel}).
        </p>
        <div className={styles.formActions}>
          <button type="submit" className={styles.button} disabled={busy !== null || !text.trim()}>
            {busy === "add" ? (verify ? "Checking…" : "Adding…") : "Add keys"}
          </button>
        </div>
      </form>

      {results && (
        <div className={styles.keyPanel} style={{ marginTop: 14 }}>
          <div className={styles.label} style={{ marginBottom: 8 }}>
            {results.filter((r) => r.status === "added").length} of {results.length} added
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td className={styles.mono}>{r.masked}</td>
                    <td>
                      <span className={`${styles.badge} ${RESULT_BADGES[r.status].className}`}>
                        {RESULT_BADGES[r.status].label}
                      </span>
                    </td>
                    <td className={styles.dim}>{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.some((r) => r.status !== "added" && r.status !== "duplicate") && (
            <p className={styles.fieldHint} style={{ marginTop: 8 }}>
              The keys that weren&apos;t added are still in the box: fix them and press Add keys again.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
