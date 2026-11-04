"use client";

// The console's VS Code extension page: download the package, then install it
// and point it at this gateway. A website can't install into VS Code, so those
// last steps happen in VS Code itself.

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import styles from "./page.module.css";
import { CopyButton } from "./ui";

type ExtensionPackage = {
  fileName: string;
  version: string;
  size: number;
  address: string;
};

function CodeLine({ label, code }: { label: string; code: string }) {
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockLabel}>{label}</div>
      <div className={styles.codeBlockBody}>
        <pre className={styles.pre}>{code}</pre>
        <CopyButton value={code} />
      </div>
    </div>
  );
}

export function ExtensionDownload({ onOpenKeys }: { onOpenKeys: () => void }) {
  const [pkg, setPkg] = useState<ExtensionPackage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch("/api/extension", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok) setPkg(data);
        else setError(data?.error || `Couldn't find the extension (HTTP ${res.status})`);
      } catch {
        if (!cancelled) setError("Network error reaching /api/extension");
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className={styles.alert}>{error}</div>;
  if (!pkg) return <p className={styles.empty}>Loading…</p>;

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Thun Murex for VS Code</span>
          <span className={`${styles.badge} ${styles.badgeAccent}`}>v{pkg.version}</span>
        </div>
        <p className={styles.sectionDesc}>
          Every provider and model behind this gateway, in a chat panel inside VS Code.
        </p>
        <div className={styles.quickActions}>
          <a className={styles.button} href="/api/extension?download=1" download={pkg.fileName}>
            <Icon name="download" /> Download
          </a>
          <span className={styles.meta}>
            {pkg.fileName} · {Math.max(1, Math.round(pkg.size / 1024))} KB
          </span>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Install it</span>
        </div>
        <p className={styles.sectionDesc}>
          In VS Code, open the Extensions view (Ctrl+Shift+X), click the <strong>⋯</strong> at its
          top, choose <strong>Install from VSIX…</strong> and pick the file you downloaded.
        </p>
        <CodeLine
          label="Or in a terminal, with the file in your Downloads folder"
          code={`code --install-extension ~/Downloads/${pkg.fileName}`}
        />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Connect it to this gateway</span>
        </div>
        <p className={styles.sectionDesc}>
          Open the Command Palette (Ctrl+Shift+P), run <strong>Thun Murex: Set API Key</strong> and
          paste a key. VS Code keeps it in its secret storage.
        </p>
        <div className={styles.quickActions}>
          <button type="button" className={styles.linkButton} onClick={onOpenKeys}>
            Make a key on the API keys page <Icon name="arrow" />
          </button>
        </div>
        <p className={styles.sectionDesc}>
          The extension starts out with the gateway&apos;s Tailscale address. If you&apos;re not on
          the tailnet, add this to your VS Code <code>settings.json</code>:
        </p>
        <CodeLine label="settings.json" code={`"aiThun.baseUrl": "${pkg.address}"`} />
      </section>
    </>
  );
}
