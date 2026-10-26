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
