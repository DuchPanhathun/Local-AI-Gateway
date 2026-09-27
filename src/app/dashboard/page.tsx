"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

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

function Bar({ used, limit }: { used: number; limit?: number }) {
  if (!limit) {
    return <span style={{ color: "#888" }}>{used.toLocaleString()} (no published limit)</span>;
  }
  const pct = Math.min(100, (used / limit) * 100);
  const color = pct >= 90 ? "#ff5555" : pct >= 70 ? "#e5c07b" : "#4ade80";
  return (
    <div>
      <div style={{ fontSize: 12, marginBottom: 2 }}>
        {used.toLocaleString()} / {limit.toLocaleString()} ({pct.toFixed(1)}%)
      </div>
      <div style={{ background: "#222", borderRadius: 4, height: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, background: color, height: "100%" }} />
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
      if (!res.ok) return; // errors here are non-fatal to the rest of the page
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
      <main style={{ fontFamily: "monospace", padding: "2rem", maxWidth: 480 }}>
        <h1>ai-thun quotas</h1>
        <p>Enter your APP_API_KEY to view remaining quota per key.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem(STORAGE_KEY, inputValue);
            setAppKey(inputValue);
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            type="password"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="APP_API_KEY"
            style={{ flex: 1, padding: 8, fontFamily: "monospace" }}
          />
          <button type="submit" style={{ padding: "8px 16px" }}>
            View
          </button>
        </form>
        {error && <p style={{ color: "#ff5555" }}>{error}</p>}
      </main>
    );
  }

  const grouped = (keys ?? []).reduce<Record<string, KeyUsage[]>>((acc, k) => {
    (acc[k.provider] ??= []).push(k);
    return acc;
  }, {});

  return (
    <main style={{ fontFamily: "monospace", padding: "2rem", maxWidth: 960 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>ai-thun quotas</h1>
        <button
          onClick={() => {
            sessionStorage.removeItem(STORAGE_KEY);
            setAppKey(null);
            setKeys(null);
          }}
          style={{ padding: "4px 10px" }}
        >
          Sign out
        </button>
      </div>

      <section style={{ marginTop: "1.5rem" }}>
        <h2>API tokens</h2>
        <p style={{ color: "#888", fontSize: 12 }}>
          Tokens you generate here can call <code>/api/chat</code> (and nothing else) —
          hand them to other apps instead of your APP_API_KEY, and revoke individually
          whenever you want.
        </p>

        <form onSubmit={handleCreateToken} style={{ display: "flex", gap: 8, margin: "0.5rem 0" }}>
          <input
            value={tokenLabel}
            onChange={(e) => setTokenLabel(e.target.value)}
            placeholder="Label (e.g. my other app)"
            style={{ flex: 1, padding: 8, fontFamily: "monospace" }}
          />
          <button type="submit" disabled={tokenBusy} style={{ padding: "8px 16px" }}>
            {tokenBusy ? "Generating…" : "Generate token"}
          </button>
        </form>

        {tokenError && <p style={{ color: "#ff5555" }}>{tokenError}</p>}

        {newToken && (
          <div
            style={{
              background: "#111",
              color: "#4ade80",
              padding: "0.75rem 1rem",
              borderRadius: 8,
              margin: "0.5rem 0",
              wordBreak: "break-all",
            }}
          >
            <div style={{ color: "#e5c07b", marginBottom: 4 }}>
              Copy this now — it won&apos;t be shown again:
            </div>
            {newToken}
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setNewToken(null)} style={{ padding: "4px 10px" }}>
                Done
              </button>
            </div>
          </div>
        )}

        {tokens && tokens.length > 0 && (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #333" }}>
                <th style={{ padding: "6px 10px" }}>Label</th>
                <th style={{ padding: "6px 10px" }}>Token</th>
                <th style={{ padding: "6px 10px" }}>Created</th>
                <th style={{ padding: "6px 10px" }}></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid #222" }}>
                  <td style={{ padding: "6px 10px" }}>{t.label}</td>
                  <td style={{ padding: "6px 10px", color: "#888" }}>{t.masked}</td>
                  <td style={{ padding: "6px 10px", color: "#888" }}>
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td style={{ padding: "6px 10px" }}>
                    <button onClick={() => handleRevoke(t.id)} style={{ padding: "2px 8px" }}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tokens && tokens.length === 0 && (
          <p style={{ color: "#888" }}>No tokens generated yet.</p>
        )}
      </section>

      {error && <p style={{ color: "#ff5555" }}>{error}</p>}
      {generatedAt && (
        <p style={{ color: "#888", fontSize: 12 }}>
          Updated {new Date(generatedAt).toLocaleTimeString()} · refreshes every{" "}
          {REFRESH_MS / 1000}s · counts are best-effort (in-memory per server instance)
        </p>
      )}

      {keys === null && <p>Loading…</p>}
      {keys !== null && keys.length === 0 && <p>No API keys configured.</p>}

      {Object.entries(grouped).map(([provider, rows]) => (
        <section key={provider} style={{ marginTop: "2rem" }}>
          <h2 style={{ textTransform: "capitalize" }}>{provider}</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #333" }}>
                  <th style={{ padding: "6px 10px" }}>Key</th>
                  <th style={{ padding: "6px 10px" }}>Model</th>
                  <th style={{ padding: "6px 10px" }}>Requests / min</th>
                  <th style={{ padding: "6px 10px" }}>Tokens / min</th>
                  <th style={{ padding: "6px 10px" }}>Requests today</th>
                  <th style={{ padding: "6px 10px" }}>Tokens today</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.keyName}:${r.model}`} style={{ borderBottom: "1px solid #222" }}>
                    <td style={{ padding: "6px 10px" }}>{r.keyName}</td>
                    <td style={{ padding: "6px 10px", color: "#888" }}>{r.model}</td>
                    <td style={{ padding: "6px 10px", minWidth: 140 }}>
                      <Bar used={r.requestsLast60s} limit={r.limits?.requestsPerMin} />
                    </td>
                    <td style={{ padding: "6px 10px", minWidth: 140 }}>
                      <Bar used={r.tokensLast60s} limit={r.limits?.tokensPerMin} />
                    </td>
                    <td style={{ padding: "6px 10px", minWidth: 140 }}>
                      <Bar used={r.requestsToday} limit={r.limits?.requestsPerDay} />
                    </td>
                    <td style={{ padding: "6px 10px", minWidth: 140 }}>
                      <Bar used={r.tokensToday} limit={r.limits?.tokensPerDay} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}
