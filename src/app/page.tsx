"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "./page.module.css";

type Limits = {
  requestsPerMin?: number;
  requestsPerDay?: number;
  tokensPerMin?: number;
  tokensPerDay?: number;
};

type KeyUsage = {
  provider: string;
  keyName: string;
  model: string;
  requestsLast60s: number;
  tokensLast60s: number;
  requestsToday: number;
  tokensToday: number;
  limits?: Limits;
};

type ApiTokenSummary = {
  id: string;
  label: string;
  createdAt: string;
  masked: string;
};

const STORAGE_KEY = "ai-thun-dashboard-app-key";
const REFRESH_MS = 15_000;

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — the value is still visible to select manually
    }
  }
  return (
    <button className={styles.buttonGhost} onClick={copy}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function ProgressBar({ used, limit }: { used: number; limit?: number }) {
  if (!limit) {
    return <span className={styles.dim}>{used.toLocaleString()}</span>;
  }
  const pct = Math.min(100, (used / limit) * 100);
  const color = pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warning)" : "var(--success)";
  return (
    <div>
      <div className={styles.progressLabel}>
        {used.toLocaleString()} / {limit.toLocaleString()} ({pct.toFixed(1)}%)
      </div>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [appKey, setAppKey] = useState<string | null>(() =>
    typeof window === "undefined" ? null : sessionStorage.getItem(STORAGE_KEY)
  );
  const [inputValue, setInputValue] = useState("");
  const [keys, setKeys] = useState<KeyUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const [tokens, setTokens] = useState<ApiTokenSummary[] | null>(null);
  const [tokenLabel, setTokenLabel] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));

  const load = useCallback(async (key: string) => {
    try {
      const res = await fetch("/api/quotas", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.status === 401) {
        setError("Wrong key — check APP_API_KEY and try again.");
        sessionStorage.removeItem(STORAGE_KEY);
        setAppKey(null);
        return;
      }
      if (!res.ok) {
        setError(`Request failed (HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      setKeys(data.keys);
      setGeneratedAt(data.generatedAt);
      setError(null);
    } catch {
      setError("Network error reaching /api/quotas");
    }
  }, []);

  const loadTokens = useCallback(async (key: string) => {
    try {
      const res = await fetch("/api/tokens", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setTokens(data.tokens);
    } catch {
      // network hiccup — leave the previous list showing
    }
  }, []);

  useEffect(() => {
    if (!appKey) return;
    let cancelled = false;

    async function tick() {
      if (!cancelled && appKey) {
        await load(appKey);
        await loadTokens(appKey);
      }
    }

    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [appKey, load, loadTokens]);

  async function handleCreateToken(e: FormEvent) {
    e.preventDefault();
    if (!appKey) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { Authorization: `Bearer ${appKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ label: tokenLabel }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTokenError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setNewToken(data.token);
      setTokenLabel("");
      await loadTokens(appKey);
    } catch {
      setTokenError("Network error creating token");
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!appKey) return;
    if (!confirm("Revoke this token? Anything using it will stop working immediately.")) return;
    try {
      const res = await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${appKey}` },
      });
      if (res.ok) await loadTokens(appKey);
    } catch {
      // best-effort — the list will just look stale until next refresh
    }
  }

  if (!appKey) {
    return (
      <main className={styles.loginWrap}>
        <div className={styles.loginCard}>
          <div className={styles.brand}>
            <span className={styles.brandMark} />
            <span className={styles.brandName}>ai-thun</span>
          </div>
          <p className={styles.subtitle}>Sign in with your APP_API_KEY to manage the AI gateway.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sessionStorage.setItem(STORAGE_KEY, inputValue);
              setAppKey(inputValue);
            }}
          >
            <div className={styles.field}>
              <label className={styles.label} htmlFor="appkey">
                APP_API_KEY
              </label>
              <input
                id="appkey"
                type="password"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="••••••••••••••••"
                className={styles.input}
                autoFocus
              />
            </div>
            <button
              type="submit"
              className={`${styles.button} ${styles.buttonFull}`}
              style={{ marginTop: 16 }}
            >
              Sign in
            </button>
          </form>
          {error && <div className={styles.alert}>{error}</div>}
        </div>
      </main>
    );
  }

  const grouped = (keys ?? []).reduce<Record<string, KeyUsage[]>>((acc, k) => {
    (acc[k.provider] ??= []).push(k);
    return acc;
  }, {});

  const totalRequestsToday = (keys ?? []).reduce((sum, k) => sum + k.requestsToday, 0);
  const totalTokensToday = (keys ?? []).reduce((sum, k) => sum + k.tokensToday, 0);
  const providerCount = Object.keys(grouped).length;
  const activeTokenCount = tokens?.length ?? 0;

  return (
    <main className={styles.shell}>
      <div className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} />
          <span className={styles.brandName}>ai-thun</span>
        </div>
        <div className={styles.headerRight}>
          {generatedAt && (
            <span className={styles.meta}>
              <span className={styles.liveDot} />
              Updated {new Date(generatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            className={styles.buttonGhost}
            onClick={() => {
              sessionStorage.removeItem(STORAGE_KEY);
              setAppKey(null);
              setKeys(null);
              setTokens(null);
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {error && <div className={styles.alert} style={{ marginBottom: 16 }}>{error}</div>}

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Requests today</div>
          <div className={styles.statValue}>{totalRequestsToday.toLocaleString()}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Tokens today</div>
          <div className={styles.statValue}>{totalTokensToday.toLocaleString()}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Providers</div>
          <div className={styles.statValue}>{providerCount}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Active tokens</div>
          <div className={styles.statValue}>{activeTokenCount}</div>
        </div>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>API tokens</span>
        </div>
        <p className={styles.sectionDesc}>
          Tokens generated here can call <code>/api/chat</code> and nothing else — hand them to
          other apps instead of your APP_API_KEY, and revoke individually at any time.
        </p>

        <form onSubmit={handleCreateToken} className={styles.inlineForm}>
          <input
            value={tokenLabel}
            onChange={(e) => setTokenLabel(e.target.value)}
            placeholder="Label (e.g. my other app)"
            className={styles.input}
          />
          <button type="submit" disabled={tokenBusy} className={styles.button}>
            {tokenBusy ? "Generating…" : "Generate token"}
          </button>
        </form>

        {tokenError && <div className={styles.alert}>{tokenError}</div>}

        {newToken && (
          <div className={styles.reveal}>
            <div className={styles.revealLabel}>Copy this now — it won&apos;t be shown again</div>
            <div className={styles.revealRow}>
              <span className={styles.revealValue}>{newToken}</span>
              <CopyButton value={newToken} />
              <button className={styles.buttonGhost} onClick={() => setNewToken(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        {tokens && tokens.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Token</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.label}</td>
                    <td className={`${styles.mono} ${styles.dim}`}>{t.masked}</td>
                    <td className={styles.dim}>{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button className={styles.buttonDanger} onClick={() => handleRevoke(t.id)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tokens && tokens.length === 0 && <p className={styles.empty}>No tokens generated yet.</p>}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>How to use</span>
        </div>
        <p className={styles.sectionDesc}>
          POST to <code>/api/chat</code> with an <code>Authorization: Bearer</code> header (your
          APP_API_KEY or any generated token above) and a JSON body.
        </p>

        <div className={styles.codeBlock}>
          <div className={styles.codeBlockLabel}>Basic request</div>
          <div className={styles.codeBlockBody}>
            <pre className={styles.pre}>{`curl -X POST ${origin}/api/chat \\
  -H "Authorization: Bearer ${appKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "Hello!"}'`}</pre>
            <CopyButton
              value={`curl -X POST ${origin}/api/chat \\\n  -H "Authorization: Bearer ${appKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "Hello!"}'`}
            />
          </div>
        </div>

        <div className={styles.codeBlock}>
          <div className={styles.codeBlockLabel}>Choosing a provider &amp; model</div>
          <div className={styles.codeBlockBody}>
            <pre className={styles.pre}>{`curl -X POST ${origin}/api/chat \\
  -H "Authorization: Bearer ${appKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "groq", "model": "openai/gpt-oss-120b", "prompt": "Hello!"}'`}</pre>
            <CopyButton
              value={`curl -X POST ${origin}/api/chat \\\n  -H "Authorization: Bearer ${appKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"provider": "groq", "model": "openai/gpt-oss-120b", "prompt": "Hello!"}'`}
            />
          </div>
        </div>

        <p className={styles.sectionDesc} style={{ marginBottom: 8 }}>
          <code>prompt</code> (string) is a shortcut for a single user message. For multi-turn
          context, send <code>messages</code> instead:{" "}
          <code>{`{"messages": [{"role": "user", "content": "Hello!"}]}`}</code>. The response is
          the provider&apos;s raw OpenAI-style JSON — the reply text is at{" "}
          <code>response.choices[0].message.content</code>.
        </p>

        <table className={styles.refTable}>
          <tbody>
            <tr>
              <td className={styles.mono}>provider</td>
              <td className={styles.dim}>
                optional, defaults to <code>sea-lion</code> — or <code>cerebras</code> /{" "}
                <code>groq</code>
              </td>
            </tr>
            <tr>
              <td className={styles.mono}>model</td>
              <td className={styles.dim}>
                optional — any model id the chosen provider supports; falls back to that
                provider&apos;s configured default
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {keys === null && <p className={styles.empty}>Loading…</p>}
      {keys !== null && keys.length === 0 && (
        <p className={styles.empty}>No API keys configured.</p>
      )}

      {Object.entries(grouped).map(([provider, rows]) => (
        <section key={provider} className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle} style={{ textTransform: "capitalize" }}>
              {provider}
            </span>
            <span className={`${styles.badge} ${styles.badgeAccent}`}>
              {rows.length} key{rows.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Model</th>
                  <th>Requests / min</th>
                  <th>Tokens / min</th>
                  <th>Requests today</th>
                  <th>Tokens today</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.keyName}:${r.model}`}>
                    <td className={styles.mono}>{r.keyName}</td>
                    <td className={styles.dim}>{r.model}</td>
                    <td style={{ minWidth: 140 }}>
                      <ProgressBar used={r.requestsLast60s} limit={r.limits?.requestsPerMin} />
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <ProgressBar used={r.tokensLast60s} limit={r.limits?.tokensPerMin} />
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <ProgressBar used={r.requestsToday} limit={r.limits?.requestsPerDay} />
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <ProgressBar used={r.tokensToday} limit={r.limits?.tokensPerDay} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <p className={styles.meta} style={{ marginTop: 8 }}>
        Refreshes every {REFRESH_MS / 1000}s · quota counts are best-effort (in-memory per server
        instance) · token list is persistent
      </p>
    </main>
  );
}
