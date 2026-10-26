"use client";

// Small pieces the console's pages share.

import { useState } from "react";
import styles from "./page.module.css";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
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
    <button type="button" className={styles.buttonGhost} onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}

export function ProgressBar({ used, limit }: { used: number; limit?: number }) {
  if (!limit) {
    return <span className={styles.dim}>{used.toLocaleString()}</span>;
  }
  const pct = Math.min(100, (used / limit) * 100);
  const color =
    pct >= 90
      ? "var(--danger)"
      : pct >= 70
        ? "var(--warning)"
        : "var(--success)";
  return (
    <div>
      <div className={styles.progressLabel}>
        {used.toLocaleString()} / {limit.toLocaleString()} ({pct.toFixed(1)}%)
      </div>
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

const compactFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCount(n: number): string {
  return n >= 10_000 ? compactFormat.format(n) : n.toLocaleString();
}

// "2026-10" → "October 2026"; "2026-10-15" → "Oct 15". Usage days are UTC.
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export type UsageCounts = {
  requests: number;
  errors: number;
  tokens: number;
  estimatedTokens: number;
};

// A key's or an account's use in one month, as /api/tokens, /api/users and
// /api/account send it.
export type MonthUsage = {
  month: string;
  totals: UsageCounts;
  days: { day: string; requests: number; tokens: number }[];
  models: (UsageCounts & { provider: string; model: string })[];
};

// That month's totals, tokens per day and models, with a month picker.
export function UsagePanel({
  usage,
  month,
  months,
  onMonth,
  labels,
  today,
}: {
  usage: MonthUsage | null; // null while it loads
  month: string;
  months: string[];
  onMonth: (month: string) => void;
  labels: Map<string, string>; // provider id → name
  today: string; // "2026-10-26", UTC
}) {
  const peakDay = usage?.days.reduce<{ day: string; tokens: number } | null>(
    (peak, d) => (d.tokens > (peak?.tokens ?? 0) ? d : peak),
    null,
  );
  const monthOptions = months.includes(month) ? months : [month, ...months];
  return (
    <>
    <div className={styles.sectionHeader}>
      <span className={styles.sectionTitle}>Usage</span>
      <select
        className={`${styles.select} ${styles.selectCompact}`}
        value={month}
        onChange={(e) => onMonth(e.target.value)}
        aria-label="Month"
      >
        {monthOptions.map((m) => (
          <option key={m} value={m}>
            {monthLabel(m)}
          </option>
        ))}
      </select>
    </div>
    {!usage ? (
      <p className={styles.empty}>Loading…</p>
    ) : (
      <>
        <div className={styles.usageSummary}>
          {(
            [
              ["Tokens", usage.totals.tokens],
              ["Estimated tokens", usage.totals.estimatedTokens],
              ["Requests", usage.totals.requests - usage.totals.errors],
              ["Failed", usage.totals.errors],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className={styles.usageFigure}>
              <span
                className={styles.usageFigureValue}
                title={value.toLocaleString()}
              >
                {formatCount(value)}
              </span>
              <span className={styles.usageFigureLabel}>{label}</span>
            </div>
          ))}
        </div>

        <div className={styles.chartHead}>
          <span>Tokens per day (UTC)</span>
          <span>
            {peakDay
              ? `Peak ${formatCount(peakDay.tokens)} on ${dayLabel(peakDay.day)}`
              : ""}
          </span>
        </div>
        <div className={styles.chart}>
          {usage.days.map((d) => {
            const future = d.day > today;
            const height = peakDay
              ? Math.max((d.tokens / peakDay.tokens) * 100, 2)
              : 0;
            return (
              <div
                key={d.day}
                className={styles.chartCol}
                title={
                  future
                    ? dayLabel(d.day)
                    : `${dayLabel(d.day)}: ${d.tokens.toLocaleString()} tokens · ${d.requests.toLocaleString()} request${d.requests === 1 ? "" : "s"}`
                }
              >
                <div
                  className={`${styles.chartBar} ${
                    future
                      ? styles.chartBarFuture
                      : d.tokens
                        ? ""
                        : styles.chartBarEmpty
                  } ${d.day === today ? styles.chartBarToday : ""}`}
                  style={d.tokens ? { height: `${height}%` } : undefined}
                />
              </div>
            );
          })}
        </div>
        <div className={styles.chartAxis}>
          {usage.days.map((d, i) => (
            <span key={d.day}>
              {i % 7 === 0 ? Number(d.day.slice(8)) : ""}
            </span>
          ))}
        </div>

        {usage.models.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Requests</th>
                  <th>Failed</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {usage.models.map((m) => (
                  <tr key={`${m.provider}:${m.model}`}>
                    <td
                      className={
                        m.model === "default" ? styles.dim : styles.mono
                      }
                    >
                      {m.model === "default" ? "CLI default" : m.model}
                    </td>
                    <td className={styles.dim}>
                      {labels.get(m.provider) ?? m.provider}
                    </td>
                    <td>{(m.requests - m.errors).toLocaleString()}</td>
                    <td>{m.errors.toLocaleString()}</td>
                    <td>
                      {m.tokens.toLocaleString()}
                      {m.estimatedTokens > 0 && (
                        <span className={styles.dim}>
                          {" "}
                          (≈{formatCount(m.estimatedTokens)} estimated)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>
            No requests in {monthLabel(usage.month)}.
          </p>
        )}
      </>
    )}
    </>
  );
}
