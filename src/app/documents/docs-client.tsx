"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getThemePref, setThemePref, subscribeTheme, type ThemePref } from "../theme";
import styles from "./docs.module.css";

// ---------------------------------------------------------------------------
// The gateway's own address, for the examples. The server doesn't know which
// hostname the page was opened under, so it renders a placeholder that the
// browser swaps for the real one.
// ---------------------------------------------------------------------------

const ORIGIN_PLACEHOLDER = "https://your-ai-thun-host";
const noSubscribe = () => () => {};

function useOrigin(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => ORIGIN_PLACEHOLDER,
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className={styles.copy}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // clipboard unavailable — the code can still be selected by hand
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// `{{ORIGIN}}` in `code` becomes this page's address.
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const text = code.replaceAll("{{ORIGIN}}", useOrigin());
  return (
    <div className={styles.code}>
      <div className={styles.codeHead}>
        <span className={styles.codeLabel}>{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className={styles.pre}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code in several languages. Picking one switches every tab group on the page
// and is remembered for next time.
// ---------------------------------------------------------------------------

const LANG_KEY = "ai-thun-docs-lang";
const LANG_EVENT = "ai-thun-docs-lang-change";
let memoryLang = ""; // when localStorage is blocked

function subscribeLang(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(LANG_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(LANG_EVENT, callback);
  };
}

function getLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? memoryLang;
  } catch {
    return memoryLang;
  }
}

function setLang(lang: string) {
  memoryLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {}
  window.dispatchEvent(new Event(LANG_EVENT));
}

export function CodeTabs({ tabs }: { tabs: { label: string; code: string }[] }) {
  const lang = useSyncExternalStore(subscribeLang, getLang, () => "");
  const origin = useOrigin();
  const active = tabs.find((t) => t.label === lang) ?? tabs[0];
  const text = active.code.replaceAll("{{ORIGIN}}", origin);
  return (
    <div className={styles.code}>
      <div className={styles.codeHead}>
        <div className={styles.tabs} role="tablist">
          {tabs.map((t) => (
            <button
              key={t.label}
              type="button"
              role="tab"
              aria-selected={t === active}
              className={`${styles.tab} ${t === active ? styles.tabActive : ""}`}
              onClick={() => setLang(t.label)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CopyButton text={text} />
      </div>
      <pre className={styles.pre}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar: highlights the section being read.
// ---------------------------------------------------------------------------

export type NavGroup = { title: string; items: { id: string; label: string }[] };

export function DocsNav({ groups }: { groups: NavGroup[] }) {
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  const idsKey = ids.join(" ");
  const [active, setActive] = useState(ids[0]);

  useEffect(() => {
    const sectionIds = idsKey.split(" ");
    let frame = 0;
    const update = () => {
      frame = 0;
      // The last section whose top has scrolled up under the top bar.
      let current = sectionIds[0];
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 100) current = id;
      }
      // Short sections at the very end can't reach the top; at the bottom of
      // the page, the last one is the one being read.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActive(atBottom ? sectionIds[sectionIds.length - 1] : current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [idsKey]);

  return (
    <nav aria-label="Documentation">
      {groups.map((g) => (
        <div key={g.title} className={styles.navGroup}>
          <div className={styles.navGroupTitle}>{g.title}</div>
          {g.items.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={`${styles.navLink} ${active === item.id ? styles.navLinkActive : ""}`}
              aria-current={active === item.id ? "location" : undefined}
            >
              {item.label}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Theme: the same Auto/Light/Dark choice as the console.
// ---------------------------------------------------------------------------

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Paths from Lucide (ISC license).
const THEME_OPTIONS: [ThemePref, string, ReactNode][] = [
  [
    "system",
    "Auto",
    <Svg key="system">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </Svg>,
  ],
  [
    "light",
    "Light",
    <Svg key="light">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Svg>,
  ],
  [
    "dark",
    "Dark",
    <Svg key="dark">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Svg>,
  ],
];

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemePref,
    () => "system" as ThemePref,
  );
  return (
    <div className={styles.themeToggle} role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          className={`${styles.themeOption} ${theme === value ? styles.themeOptionActive : ""}`}
          onClick={() => setThemePref(value)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
