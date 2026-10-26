"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { ApiKeys, type KeySummary } from "./api-keys";
import { Codes } from "./codes";
import { Logo } from "./logo";
import styles from "./page.module.css";
import {
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  type ChatProvider,
} from "./providers";
import { Shop } from "./shop";
import { getThemePref, setThemePref, subscribeTheme, type ThemePref } from "./theme";
import { CopyButton, dayLabel, formatCount, monthLabel, ProgressBar } from "./ui";
import { Users } from "./users";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// One local CLI + model's runs today, from /api/quotas.
type LocalUsage = {
  provider: string;
  model: string;
  requestsToday: number;
  errorsToday: number;
  promptTokensToday: number;
  completionTokensToday: number;
  tokensToday: number;
  tokensReported: boolean;
  avgDurationMs: number | null;
  finishedToday: number;
  lastUsedAt: string;
};

type UsageTotals = {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type ModelUsage = UsageTotals & {
  provider: string;
  model: string;
  tokensReported: boolean;
  avgDurationMs: number | null;
  timed: number;
  lastUsedAt: string | null;
};

// One month across every provider, from /api/usage.
type MonthUsage = {
  month: string;
  months: string[];
  totals: UsageTotals;
  models: ModelUsage[];
  days: { day: string; requests: number; totalTokens: number }[];
};

type LocalAgentProviderHealth = {
  installed: boolean;
  path: string | null;
  version: string | null;
  supports_resume?: boolean;
  supports_images?: boolean;
  supports_no_tools?: boolean;
  error?: string | null; // set when this provider's gateway couldn't be reached
};

type LocalAgentHealth = {
  status: string;
  providers: Record<string, LocalAgentProviderHealth>;
};

// One of a local CLI's subscription limits, from /api/local-agent/limits.
type PlanLimit = {
  id: string;
  window: string; // "5h", "weekly", as the CLI names it
  remaining_fraction: number; // 0-1
  resets_at: string | null;
  name: string | null;
  group: string | null; // set when separate model families have separate limits
  models: string | null;
};

type ProviderPlanLimits = {
  installed: boolean;
  supported: boolean; // the CLI can report its limits
  limits: PlanLimit[];
  checked_at: string | null;
  error: string | null;
};

const WEB_PROVIDERS: readonly string[] = ["chatgpt", "grok", "mimo"];
const WEB_HOSTS: Record<string, string> = {
  chatgpt: "chatgpt.com",
  grok: "grok.com",
  mimo: "Xiaomi MiMo Studio",
};

function isCloudProvider(p: ChatProvider): boolean {
  return (CLOUD_PROVIDERS as readonly string[]).includes(p);
}

function isWebProvider(p: ChatProvider): boolean {
  return WEB_PROVIDERS.includes(p);
}

function localKind(p: ChatProvider): string {
  return isWebProvider(p) ? "Website" : "Local CLI";
}

// Sentinel <select> value: the model id is typed into a text field instead.
const CUSTOM_MODEL = "__custom__";

type ProviderModels = {
  kind: "cloud" | "local";
  default: string | null;
  models: { id: string; name: string }[];
  note: string | null;
  error: string | null;
};

type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ChatDone = {
  result: string;
  model?: string | null;
  session_id?: string;
  finish_reason?: string | null;
  usage?: ChatUsage | null;
  duration_ms?: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  finishReason?: string | null;
  isError?: boolean;
};

type View = "dashboard" | "playground" | "api-keys" | "users" | "codes" | "shop" | "analytics" | "manage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_MS = 15_000;

const NAV_ITEMS: {
  id: View;
  label: string;
  icon: IconName;
  description: string;
}[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "dashboard",
    description:
      "Today's traffic and the state of every provider, cloud APIs and local agent CLIs alike.",
  },
  {
    id: "playground",
    label: "Playground",
    icon: "playground",
    description:
      "Try prompts against any provider and model. Responses stream as they're generated.",
  },
  {
    id: "api-keys",
    label: "API keys",
    icon: "key",
    description:
      "Keys for other people and apps, each with its own limits, expiry and usage. Only you can manage them.",
  },
  {
    id: "users",
    label: "Users",
    icon: "users",
    description:
      "People with accounts: activate them with a plan, top them up, and see what each one uses.",
  },
  {
    id: "codes",
    label: "Redeem codes",
    icon: "ticket",
    description:
      "Codes to sell or give away: a plan code activates or renews an account, a top-up adds to it.",
  },
  {
    id: "shop",
    label: "Shop",
    icon: "cart",
    description:
      "Token packs people buy with PayPal, at half the market price or less, and their orders.",
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: "analytics",
    description:
      "Today's usage for every provider: per key for cloud APIs, per model for local CLIs.",
  },
  {
    id: "manage",
    label: "Manage",
    icon: "manage",
    description:
      "Pause or resume providers, the API reference, and the coding CLIs installed on this machine.",
  },
];

const SUGGESTIONS = {
  cloud: [
    "Translate “Stocks rose 2% on Friday” into Khmer",
    "Explain API key rotation in two sentences",
    "Write a haiku about Phnom Penh",
  ],
  local: [
    "What does this project do?",
    "List the main files in this directory",
    "Find any TODO comments in the code",
  ],
};

// ---------------------------------------------------------------------------
// Small components & helpers
// ---------------------------------------------------------------------------

// Line icons (paths from Lucide, ISC license).
type IconName =
  | "dashboard"
  | "playground"
  | "key"
  | "users"
  | "ticket"
  | "cart"
  | "analytics"
  | "manage"
  | "logout"
  | "sun"
  | "moon"
  | "monitor"
  | "arrow"
  | "cloud"
  | "terminal"
  | "activity"
  | "hash"
  | "layers"
  | "book"
  | "stop"
  | "send"
  | "sparkle"
  | "pause"
  | "play";

const ICON_PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </>
  ),
  playground: (
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  ticket: (
    <>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </>
  ),
  cart: (
    <>
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </>
  ),
  analytics: (
    <>
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </>
  ),
  manage: (
    <>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  monitor: (
    <>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </>
  ),
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  hash: (
    <>
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </>
  ),
  layers: (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </>
  ),
  book: (
    <>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  send: (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  sparkle: (
    <path d="M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.4l-1.9-5.8L4 10.7l6.1-1.9z" />
  ),
  pause: (
    <>
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </>
  ),
  play: <polygon points="6 3 20 12 6 21 6 3" />,
};

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// How much of a plan limit is left. Rounded the way the CLIs show it.
function RemainingBar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  const color =
    pct <= 10
      ? "var(--danger)"
      : pct <= 30
        ? "var(--warning)"
        : "var(--success)";
  return (
    <div>
      <div className={styles.progressLabel}>{Math.round(pct)}% left</div>
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

// "Claude Code, Codex and Gemini CLI".
function listLabels(providers: readonly ChatProvider[]): string {
  const names = providers.map((p) => PROVIDER_LABELS[p]);
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : (names[0] ?? "");
}

// "5h" → "5-hour", "weekly" → "Weekly".
function windowLabel(window: string): string {
  const hours = /^(\d+)h$/.exec(window);
  if (hours) return `${hours[1]}-hour`;
  return window.charAt(0).toUpperCase() + window.slice(1);
}

// "3h 45m", "6d 23h", "12m".
function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// When a limit is fully available again, in this browser's time zone:
// "9:08 PM (in 3h 45m)", with the date when it isn't today.
function resetLabel(iso: string | null, now: number): string {
  if (!iso) return "—";
  const at = new Date(iso);
  const today = at.toDateString() === new Date(now).toDateString();
  const when = at.toLocaleString("en", {
    ...(today ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
  const wait = at.getTime() - now;
  return wait > 0 ? `${when} (in ${formatWait(wait)})` : `${when} (now)`;
}

// The gateway's notes are lowercase fragments; show them as sentences.
function asSentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

// Cloud providers are stateless, so every turn resends the whole conversation.
// Turns that failed (an error, or stopped before any output) are dropped
// along with the user message that led to them, so the history never has two
// user messages in a row.
function historyForApi(messages: ChatMessage[]) {
  const failed = (m?: ChatMessage) =>
    !!m && (m.isError || (m.role === "assistant" && !m.content.trim()));
  return messages
    .filter(
      (m, i) => !failed(m) && !(m.role === "user" && failed(messages[i + 1])),
    )
    .map(({ role, content }) => ({ role, content }));
}

function finishNote(m: ChatMessage): string | null {
  const empty = !m.content.trim();
  if (m.finishReason === "length") {
    return empty
      ? "No answer: the max tokens limit was used up while thinking. Raise Max tokens and run again."
      : "Stopped at the max tokens limit — the answer may be cut off.";
  }
  if (m.finishReason === "stopped") {
    return empty ? "Stopped before any output." : "Stopped early.";
  }
  return null;
}

// Parses /api/chat/stream's Server-Sent Events and calls back as text
// arrives, rather than waiting for the whole response. Every provider uses
// the same events; only cloud models send `thinking`.
async function streamChat(
  body: Record<string, unknown>,
  signal: AbortSignal,
  handlers: {
    onThinking: (text: string) => void;
    onDelta: (text: string) => void;
    onDone: (data: ChatDone) => void;
    onError: (message: string) => void;
    onAbort: () => void;
  },
) {
  let res: Response;
  try {
    res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal.aborted) handlers.onAbort();
    else handlers.onError("Network error reaching /api/chat/stream");
    return;
  }

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    handlers.onError(
      data?.error || data?.detail || `Request failed (HTTP ${res.status})`,
    );
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let ended = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const data = JSON.parse(raw);
            if (currentEvent === "delta" && typeof data.text === "string") {
              handlers.onDelta(data.text);
            } else if (
              currentEvent === "thinking" &&
              typeof data.text === "string"
            ) {
              handlers.onThinking(data.text);
            } else if (currentEvent === "done") {
              ended = true;
              handlers.onDone(data);
            } else if (currentEvent === "error") {
              ended = true;
              handlers.onError(data.detail || "Stream error");
            }
          } catch {
            // ignore a malformed event rather than breaking the whole stream
          }
        }
      }
    }
  } catch {
    if (signal.aborted) handlers.onAbort();
    else handlers.onError("Lost the connection to the gateway mid-response");
    return;
  }

  if (!ended) handlers.onError("The stream ended without a response");
}

// Signed in or not: the server knows, from its sign-in cookie, which the page's
// scripts can't read (so the page never holds the key). undefined until the
// server has been asked: hydration then renders the same blank shell as the
// server did, instead of the sign-in screen flashing up.
const SESSION_EVENT = "ai-thun-session-change";
let signedInNow: boolean | undefined;

function subscribeSession(callback: () => void) {
  window.addEventListener(SESSION_EVENT, callback);
  return () => window.removeEventListener(SESSION_EVENT, callback);
}

function getSignedIn(): boolean | undefined {
  return signedInNow;
}

function setSignedIn(value: boolean) {
  signedInNow = value;
  window.dispatchEvent(new Event(SESSION_EVENT));
}

async function checkSession() {
  try {
    const res = await fetch("/api/session", { cache: "no-store" });
    const data = (await res.json()) as { signedIn?: boolean };
    setSignedIn(!!data.signedIn || (await adminFromAccount()));
  } catch {
    setSignedIn(false);
  }
}

// An admin already signed in with their account in this browser (on
// /account, say) gets the console without signing in again.
async function adminFromAccount(): Promise<boolean> {
  const session = (await supabaseBrowser()?.auth.getSession())?.data.session;
  if (!session) return false;
  return (await consoleSignIn({ accessToken: session.access_token })).ok;
}

// The sign-in cookie, for the owner key or an admin's account.
async function consoleSignIn(
  body: { key: string } | { accessToken: string },
): Promise<{ ok: boolean; error?: string; account?: boolean }> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    account?: boolean;
  } | null;
  return res.ok
    ? { ok: true }
    : {
        ok: false,
        error: data?.error || `Sign-in failed (HTTP ${res.status})`,
        account: data?.account,
      };
}

// Accounts are on when the build has Supabase's address and public key.
const ACCOUNTS_ON = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [view, setView] = useState<View>("dashboard");
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemePref,
    () => "system" as ThemePref,
  );
  const signedIn = useSyncExternalStore(
    subscribeSession,
    getSignedIn,
    () => undefined,
  );
  useEffect(() => {
    void checkSession();
  }, []);
  const router = useRouter();
  const [inputValue, setInputValue] = useState("");
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [useOwnerKey, setUseOwnerKey] = useState(!ACCOUNTS_ON);
  const [signingIn, setSigningIn] = useState(false);
  const [keys, setKeys] = useState<KeyUsage[] | null>(null);
  const [localUsage, setLocalUsage] = useState<LocalUsage[] | null>(null);
  const [paused, setPaused] = useState<string[]>([]);
  const [pauseBusy, setPauseBusy] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [usageMonth, setUsageMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [monthUsage, setMonthUsage] = useState<MonthUsage | null>(null);
  // Bumped to fetch the monthly report again right away (after a run).
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const [tokens, setTokens] = useState<KeySummary[] | null>(null);
  // When the list was loaded: "last used" and "expires in" are from then.
  const [tokensAt, setTokensAt] = useState(0);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [origin] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const [localAgent, setLocalAgent] = useState<LocalAgentHealth | null>(null);
  const [localAgentError, setLocalAgentError] = useState<string | null>(null);
  const [planLimits, setPlanLimits] = useState<Record<
    string,
    ProviderPlanLimits
  > | null>(null);
  const [planLimitsError, setPlanLimitsError] = useState<string | null>(null);
  // When they were last loaded: the countdowns to each reset are from then.
  const [limitsNow, setLimitsNow] = useState(0);
  const [models, setModels] = useState<Record<string, ProviderModels> | null>(
    null,
  );
  const [showIdleKeys, setShowIdleKeys] = useState(false);

  const [chatProvider, setChatProvider] = useState<ChatProvider>("claude");
  const [chatModel, setChatModel] = useState("");
  const [chatCustomModel, setChatCustomModel] = useState("");
  const [chatWorkdir, setChatWorkdir] = useState("");
  const [chatMaxTokens, setChatMaxTokens] = useState("");
  const [chatTemperature, setChatTemperature] = useState("");
  const [chatThinking, setChatThinking] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState("");
  const [chatStreamingThinking, setChatStreamingThinking] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [chatLast, setChatLast] = useState<ChatDone | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped when a conversation is cleared, so callbacks still arriving from
  // the abandoned run can't write into the new one.
  const runIdRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/quotas");
      if (res.status === 401) {
        setError("Your sign-in has ended: sign in again.");
        setSignedIn(false);
        return;
      }
      if (!res.ok) {
        setError(`Request failed (HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      setKeys(data.keys);
      setLocalUsage(data.local ?? []);
      setPaused(data.paused ?? []);
      setGeneratedAt(data.generatedAt);
      setError(null);
    } catch {
      setError("Network error reaching /api/quotas");
    }
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      const res = await fetch("/api/tokens");
      if (!res.ok) return;
      const data = await res.json();
      setTokens(data.tokens);
      setPublicOrigin(data.publicOrigin ?? null);
      setTokensAt(Date.now());
    } catch {
      // network hiccup — leave the previous list showing
    }
  }, []);

  const loadLocalAgent = useCallback(async () => {
    try {
      const res = await fetch("/api/local-agent/health");
      const data = await res.json();
      if (!res.ok) {
        setLocalAgentError(
          data.error || `local-agent-gateway unreachable (HTTP ${res.status})`,
        );
        setLocalAgent(null);
        return;
      }
      setLocalAgent(data);
      setLocalAgentError(null);
    } catch {
      setLocalAgentError("Network error reaching local-agent-gateway");
      setLocalAgent(null);
    }
  }, []);

  // The gateway asks the CLIs at most every 2 minutes, however often this runs.
  const loadPlanLimits = useCallback(async () => {
    try {
      const res = await fetch("/api/local-agent/limits");
      const data = await res.json();
      setLimitsNow(Date.now());
      if (!res.ok) {
        setPlanLimitsError(
          data.error || `Couldn't read the plan limits (HTTP ${res.status})`,
        );
        return;
      }
      setPlanLimits(data.providers);
      setPlanLimitsError(null);
    } catch {
      setPlanLimitsError("Network error reaching local-agent-gateway");
    }
  }, []);

  // Model lists change rarely (the server caches them for 10 minutes), so
  // they're fetched once per sign-in rather than on every refresh tick.
  const loadModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models");
      if (!res.ok) return;
      const data = await res.json();
      setModels(data.providers);
    } catch {
      // the model picker falls back to "Default" + "Custom…"
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;

    async function tick() {
      if (!cancelled) {
        await load();
        await loadTokens();
        await loadLocalAgent();
        await loadPlanLimits();
      }
    }

    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [signedIn, load, loadTokens, loadLocalAgent, loadPlanLimits]);

  useEffect(() => {
    if (!signedIn) return;
    async function run() {
      await loadModels();
    }
    void run();
  }, [signedIn, loadModels]);

  // The monthly report: refreshed with everything else, and at once when the
  // month changes or a run finishes. A reply for a month that's no longer
  // selected is dropped.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch(`/api/usage?month=${usageMonth}`);
        if (!res.ok) return;
        const data: MonthUsage = await res.json();
        if (!cancelled) setMonthUsage(data);
      } catch {
        // network hiccup — keep showing the last report
      }
    }
    void run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [signedIn, usageMonth, usageRefresh]);

  // Follow new output as it streams, unless the user scrolled up to read.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chatMessages, chatStreaming, chatStreamingThinking]);

  async function handleTogglePause(p: ChatProvider, pause: boolean) {
    if (!signedIn) return;
    setPauseBusy(p);
    setPauseError(null);
    try {
      const res = await fetch("/api/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p, paused: pause }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPauseError(data?.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setPaused(data.paused);
      // A paused cloud provider's model list isn't fetched; get it now.
      if (!pause) await loadModels();
    } catch {
      setPauseError("Network error reaching /api/providers");
    } finally {
      setPauseBusy(null);
    }
  }

  function handleClearChat() {
    runIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setChatMessages([]);
    setChatSessionId(null);
    setChatLast(null);
    setChatStreaming("");
    setChatStreamingThinking("");
    setChatBusy(false);
  }

  function selectProvider(p: ChatProvider) {
    setChatProvider(p);
    setChatModel("");
    setChatCustomModel("");
    handleClearChat();
  }

  function openInPlayground(p: ChatProvider) {
    selectProvider(p);
    setView("playground");
  }

  async function handleSendChat(e: FormEvent) {
    e.preventDefault();
    const prompt = chatInput.trim();
    if (!signedIn || !prompt || chatBusy || paused.includes(chatProvider)) return;

    const model =
      chatModel === CUSTOM_MODEL ? chatCustomModel.trim() : chatModel;
    const maxTokens = Number.parseInt(chatMaxTokens, 10);
    const temperature = Number.parseFloat(chatTemperature);

    // Cloud APIs are stateless: send the whole conversation every turn.
    // Local CLIs keep their own history, resumed by session_id.
    const body = isCloudProvider(chatProvider)
      ? {
          provider: chatProvider,
          messages: [
            ...historyForApi(chatMessages),
            { role: "user", content: prompt },
          ],
          ...(model ? { model } : {}),
          ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
          ...(Number.isFinite(temperature) ? { temperature } : {}),
          ...(chatProvider === "sea-lion" && !chatThinking
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
        }
      : {
          provider: chatProvider,
          prompt,
          ...(model ? { model } : {}),
          ...(chatSessionId ? { session_id: chatSessionId } : {}),
          // Temporary/private web chats can't be continued: save it so the next turn can.
          ...(isWebProvider(chatProvider)
            ? { temporary: false }
            : chatWorkdir.trim()
              ? { workdir: chatWorkdir.trim() }
              : {}),
        };

    setChatMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setChatInput("");
    setChatStreaming("");
    setChatStreamingThinking("");
    setChatBusy(true);
    stickToBottom.current = true;

    const runId = ++runIdRef.current;
    const isCurrent = () => runIdRef.current === runId;
    const controller = new AbortController();
    abortRef.current = controller;
    // Accumulated locally because the handler closures would see stale state.
    let thinking = "";
    let content = "";

    await streamChat(body, controller.signal, {
      onThinking: (text) => {
        if (!isCurrent()) return;
        thinking += text;
        setChatStreamingThinking(thinking);
      },
      onDelta: (text) => {
        if (!isCurrent()) return;
        content += text;
        setChatStreaming(content);
      },
      onDone: (data) => {
        if (!isCurrent()) return;
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.result,
            thinking: thinking || undefined,
            finishReason: data.finish_reason ?? null,
          },
        ]);
        if (data.session_id) setChatSessionId(data.session_id);
        setChatLast(data);
      },
      onError: (message) => {
        if (!isCurrent()) return;
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: message, isError: true },
        ]);
      },
      onAbort: () => {
        if (!isCurrent()) return;
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: content.trim(),
            thinking: thinking || undefined,
            finishReason: "stopped",
          },
        ]);
      },
    });
    // Count this run on the Dashboard and in Analytics now, not at the next tick.
    void load();
    setUsageRefresh((n) => n + 1);

    if (!isCurrent()) return;
    abortRef.current = null;
    setChatStreaming("");
    setChatStreamingThinking("");
    setChatBusy(false);
  }

  function signOut() {
    abortRef.current?.abort();
    void fetch("/api/session", { method: "DELETE" }).catch(() => {});
    void supabaseBrowser()?.auth.signOut();
    setSignedIn(false);
    setKeys(null);
    setLocalUsage(null);
    setMonthUsage(null);
    setPaused([]);
    setPauseError(null);
    setTokens(null);
    setLocalAgent(null);
    setPlanLimits(null);
    setPlanLimitsError(null);
    setModels(null);
    handleClearChat();
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  // The key goes to the server once; what comes back is the sign-in cookie.
  async function signIn(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSigningIn(true);
    try {
      const result = await consoleSignIn({ key: inputValue });
      if (!result.ok) {
        setError(result.error ?? "Sign-in failed");
        return;
      }
      setInputValue("");
      setSignedIn(true);
    } catch {
      setError("Network error reaching the gateway");
    } finally {
      setSigningIn(false);
    }
  }

  // An admin's account: Supabase signs them in, and its session is traded
  // for the console's cookie. Anyone else goes to their own dashboard.
  async function signInWithAccount(e: FormEvent) {
    e.preventDefault();
    const sb = supabaseBrowser();
    if (!sb) return;
    setError(null);
    setSigningIn(true);
    try {
      const { data, error } = await sb.auth.signInWithPassword({
        email: signInEmail,
        password: signInPassword,
      });
      if (error || !data.session) {
        setError(
          error && /not confirmed/i.test(error.message)
            ? "Confirm your email address first: open the link Supabase sent you."
            : (error?.message ?? "Sign-in failed"),
        );
        return;
      }
      const result = await consoleSignIn({
        accessToken: data.session.access_token,
      });
      if (result.account) {
        router.push("/account");
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Sign-in failed");
        return;
      }
      setSignInPassword("");
      setSignedIn(true);
    } catch {
      setError("Network error reaching the gateway");
    } finally {
      setSigningIn(false);
    }
  }

  // Server render and the first (hydrating) client render: whether there's
  // a sign-in isn't known yet, so show nothing rather than guess wrong.
  if (signedIn === undefined) {
    return <main className={styles.loginWrap} />;
  }

  if (!signedIn) {
    return (
      <main className={styles.loginWrap}>
        <div className={styles.loginCard}>
          <div className={styles.brand}>
            <Logo className={styles.brandMark} />
            <span className={styles.brandText}>
              <span className={styles.brandName}>Thun Murex</span>
              <span className={styles.brandSub}>AI gateway console</span>
            </span>
          </div>
          <p className={styles.subtitle}>
            Sign in to manage providers, keys, users and usage.
          </p>
          {ACCOUNTS_ON && (
            <form onSubmit={signInWithAccount} className={styles.authForm}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="signin-email">
                  Email
                </label>
                <input
                  id="signin-email"
                  type="email"
                  autoComplete="email"
                  value={signInEmail}
                  onChange={(e) => setSignInEmail(e.target.value)}
                  className={styles.input}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="signin-password">
                  Password
                </label>
                <input
                  id="signin-password"
                  type="password"
                  autoComplete="current-password"
                  value={signInPassword}
                  onChange={(e) => setSignInPassword(e.target.value)}
                  className={styles.input}
                  required
                />
              </div>
              <button
                type="submit"
                className={`${styles.button} ${styles.buttonFull}`}
                disabled={signingIn}
              >
                {signingIn && !useOwnerKey ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}
          {ACCOUNTS_ON && (
            <div className={styles.authDivider}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setUseOwnerKey(!useOwnerKey)}
              >
                {useOwnerKey ? "Hide the owner key" : "Or use the owner key"}
              </button>
            </div>
          )}
          {useOwnerKey && (
          <form onSubmit={signIn}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="appkey">
                APP_API_KEY
              </label>
              <input
                id="appkey"
                type="password"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Paste your key"
                className={styles.input}
                autoFocus
              />
            </div>
            <button
              type="submit"
              className={`${styles.button} ${styles.buttonFull}`}
              style={{ marginTop: 16 }}
              disabled={!inputValue || signingIn}
            >
              {signingIn ? "Signing in…" : "Sign in"}
            </button>
          </form>
          )}
          {error && (
            <div className={styles.alert} style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
          {ACCOUNTS_ON && (
            <div className={styles.authLinks}>
              <Link href="/account" className={styles.inlineLink}>
                Not an admin? Your account →
              </Link>
            </div>
          )}
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const grouped = (keys ?? []).reduce<Record<string, KeyUsage[]>>(
    (acc, k) => {
      (acc[k.provider] ??= []).push(k);
      return acc;
    },
    {},
  );

  function usageFor(provider: string) {
    const rows = grouped[provider] ?? [];
    return {
      keys: new Set(rows.map((r) => r.keyName)).size,
      activeKeys: new Set(
        rows.filter((r) => r.requestsToday > 0).map((r) => r.keyName),
      ).size,
      requests: rows.reduce((sum, r) => sum + r.requestsToday, 0),
      tokens: rows.reduce((sum, r) => sum + r.tokensToday, 0),
    };
  }

  // One local CLI's runs today, across every model it used.
  function localUsageFor(provider: string) {
    const rows = (localUsage ?? []).filter((r) => r.provider === provider);
    const finished = rows.reduce((sum, r) => sum + r.finishedToday, 0);
    const durationMs = rows.reduce(
      (sum, r) => sum + (r.avgDurationMs ?? 0) * r.finishedToday,
      0,
    );
    return {
      requests: rows.reduce((sum, r) => sum + r.requestsToday, 0),
      errors: rows.reduce((sum, r) => sum + r.errorsToday, 0),
      tokens: rows.reduce((sum, r) => sum + r.tokensToday, 0),
      tokensReported: rows.some((r) => r.tokensReported),
      avgDurationMs: finished ? durationMs / finished : null,
    };
  }

  // A CLI that ran today without reporting tokens (Codex, Gemini) used an
  // unknown number, not zero.
  function localTokens(u: ReturnType<typeof localUsageFor>): string {
    return u.requests > 0 && !u.tokensReported ? "—" : formatCount(u.tokens);
  }

  // Plan limits, for the CLIs that report them.
  const now = limitsNow;
  const limitProviders = LOCAL_PROVIDERS.filter(
    (p) => planLimits?.[p]?.installed && planLimits[p].supported,
  );
  const silentProviders = LOCAL_PROVIDERS.filter(
    (p) => planLimits?.[p]?.installed && !planLimits[p].supported,
  );
  const limitsCheckedAt = limitProviders
    .map((p) => planLimits?.[p]?.checked_at)
    .filter((t): t is string => !!t)
    .sort()[0];

  // The limit closest to running out, for a provider card.
  function tightestLimit(provider: string): PlanLimit | null {
    const list = planLimits?.[provider]?.limits ?? [];
    return list.reduce<PlanLimit | null>(
      (low, l) =>
        !low || l.remaining_fraction < low.remaining_fraction ? l : low,
      null,
    );
  }

  const isPaused = (p: string) => paused.includes(p);

  // Monthly report on the Dashboard. Usage days are UTC.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const usageDays = monthUsage?.days ?? [];
  const peakDay = usageDays.reduce<MonthUsage["days"][number] | null>(
    (best, d) => (d.totalTokens > (best?.totalTokens ?? 0) ? d : best),
    null,
  );
  const monthOptions = monthUsage?.months.includes(usageMonth)
    ? monthUsage.months
    : [usageMonth, ...(monthUsage?.months ?? [])];

  const totalRequestsToday =
    (keys ?? []).reduce((sum, k) => sum + k.requestsToday, 0) +
    (localUsage ?? []).reduce((sum, r) => sum + r.requestsToday, 0);
  const totalTokensToday =
    (keys ?? []).reduce((sum, k) => sum + k.tokensToday, 0) +
    (localUsage ?? []).reduce((sum, r) => sum + r.tokensToday, 0);
  const totalKeys = new Set((keys ?? []).map((k) => k.keyName)).size;
  const activeTokenCount =
    tokens?.filter((t) => t.status === "active").length ?? 0;
  const installedClis = LOCAL_PROVIDERS.filter(
    (p) => localAgent?.providers[p]?.installed,
  ).length;

  const currentNav = NAV_ITEMS.find((n) => n.id === view) ?? NAV_ITEMS[0];
  const chatIsCloud = isCloudProvider(chatProvider);
  const chatPaused = isPaused(chatProvider);
  const chatLabel = PROVIDER_LABELS[chatProvider];
  const providerModels = models?.[chatProvider];
  const effectiveModel =
    chatModel === CUSTOM_MODEL ? chatCustomModel.trim() : chatModel;
  const modelSummary =
    effectiveModel || (chatIsCloud ? providerModels?.default : null) || "";

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  const dashboardView = (
    <>
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Requests today</span>
            <span className={styles.statIcon}>
              <Icon name="activity" />
            </span>
          </div>
          <div className={styles.statValue}>
            {formatCount(totalRequestsToday)}
          </div>
          <div className={styles.statSub}>Cloud APIs and local CLIs</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Tokens today</span>
            <span className={styles.statIcon}>
              <Icon name="hash" />
            </span>
          </div>
          <div className={styles.statValue}>
            {formatCount(totalTokensToday)}
          </div>
          <div className={styles.statSub}>Prompt + completion</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Providers</span>
            <span className={styles.statIcon}>
              <Icon name="layers" />
            </span>
          </div>
          <div className={styles.statValue}>
            {CLOUD_PROVIDERS.length + LOCAL_PROVIDERS.length}
          </div>
          <div className={styles.statSub}>
            {paused.length > 0
              ? `${CLOUD_PROVIDERS.length + LOCAL_PROVIDERS.length - paused.length} active · ${paused.length} paused`
              : `${CLOUD_PROVIDERS.length} cloud APIs · ${installedClis} of ${LOCAL_PROVIDERS.length} CLIs installed`}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statHead}>
            <span className={styles.statLabel}>Access tokens</span>
            <span className={styles.statIcon}>
              <Icon name="key" />
            </span>
          </div>
          <div className={styles.statValue}>{activeTokenCount}</div>
          <div className={styles.statSub}>
            {totalKeys} provider keys in rotation
          </div>
        </div>
      </div>

      <section
        className={`${styles.section} ${
          monthUsage && monthUsage.month !== usageMonth ? styles.stale : ""
        }`}
      >
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Monthly usage</span>
          <select
            className={`${styles.select} ${styles.selectCompact}`}
            value={usageMonth}
            onChange={(e) => setUsageMonth(e.target.value)}
            aria-label="Month"
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </div>
        <p className={styles.sectionDesc}>
          Every request through the gateway, all providers and models, by UTC
          day. Saved on the server, so restarts and deploys don&apos;t reset
          it.
        </p>

        {!monthUsage ? (
          <p className={styles.empty}>Loading…</p>
        ) : (
          <>
            <div className={styles.usageSummary}>
              {(
                [
                  ["Total tokens", monthUsage.totals.totalTokens],
                  ["Input tokens", monthUsage.totals.promptTokens],
                  ["Output tokens", monthUsage.totals.completionTokens],
                  ["Requests", monthUsage.totals.requests],
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
              <span>Tokens per day</span>
              <span>
                {peakDay
                  ? `Peak ${formatCount(peakDay.totalTokens)} on ${dayLabel(peakDay.day)}`
                  : ""}
              </span>
            </div>
            <div className={styles.chart}>
              {usageDays.map((d) => {
                const future = d.day > todayUtc;
                const height = peakDay
                  ? Math.max((d.totalTokens / peakDay.totalTokens) * 100, 2)
                  : 0;
                return (
                  <div
                    key={d.day}
                    className={styles.chartCol}
                    title={
                      future
                        ? dayLabel(d.day)
                        : `${dayLabel(d.day)}: ${d.totalTokens.toLocaleString()} tokens · ${d.requests.toLocaleString()} request${d.requests === 1 ? "" : "s"}`
                    }
                  >
                    <div
                      className={`${styles.chartBar} ${
                        future
                          ? styles.chartBarFuture
                          : d.totalTokens
                            ? ""
                            : styles.chartBarEmpty
                      } ${d.day === todayUtc ? styles.chartBarToday : ""}`}
                      style={
                        d.totalTokens ? { height: `${height}%` } : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
            <div className={styles.chartAxis}>
              {usageDays.map((d, i) => (
                <span key={d.day}>
                  {i % 7 === 0 ? Number(d.day.slice(8)) : ""}
                </span>
              ))}
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Provider</th>
                    <th>Requests</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Total tokens</th>
                    <th>Share of tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {monthUsage.models.map((m) => {
                    const share = monthUsage.totals.totalTokens
                      ? (m.totalTokens / monthUsage.totals.totalTokens) * 100
                      : 0;
                    return (
                      <tr key={`${m.provider}:${m.model}`}>
                        {/* "default": a local CLI's own default model, which it didn't name */}
                        <td className={m.model === "default" ? styles.dim : styles.mono}>
                          {m.model === "default" ? "CLI default" : m.model}
                        </td>
                        <td className={styles.dim}>
                          {PROVIDER_LABELS[m.provider as ChatProvider] ??
                            m.provider}
                        </td>
                        <td>{m.requests.toLocaleString()}</td>
                        <td>
                          {m.tokensReported
                            ? m.promptTokens.toLocaleString()
                            : "—"}
                        </td>
                        <td>
                          {m.tokensReported
                            ? m.completionTokens.toLocaleString()
                            : "—"}
                        </td>
                        <td className={styles.strong}>
                          {m.tokensReported
                            ? m.totalTokens.toLocaleString()
                            : "—"}
                        </td>
                        <td style={{ minWidth: 160 }}>
                          {m.tokensReported ? (
                            <div className={styles.shareCell}>
                              <div className={styles.shareTrack}>
                                <div
                                  className={styles.shareFill}
                                  style={{ width: `${share}%` }}
                                />
                              </div>
                              <span className={styles.shareLabel}>
                                {share > 0 && share < 0.1
                                  ? "<0.1%"
                                  : `${share.toFixed(1)}%`}
                              </span>
                            </div>
                          ) : (
                            <span className={styles.dim}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {monthUsage.models.length === 0 && (
                    <tr className={styles.idleRow}>
                      <td colSpan={7}>
                        No usage in {monthLabel(monthUsage.month)}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <div className={styles.blockTitle}>Cloud APIs</div>
      <div className={styles.providerGrid}>
        {CLOUD_PROVIDERS.map((p) => {
          const u = usageFor(p);
          const m = models?.[p];
          const off = isPaused(p);
          const status = off
            ? { label: "Paused", cls: styles.badgeWarning }
            : u.keys === 0
              ? { label: "No keys", cls: styles.badgeDanger }
              : m?.error
                ? { label: "Unreachable", cls: styles.badgeDanger }
                : m
                  ? { label: "Connected", cls: styles.badgeSuccess }
                  : { label: "Checking…", cls: "" };
          return (
            <div
              key={p}
              className={`${styles.providerCard} ${off ? styles.providerCardPaused : ""}`}
            >
              <div className={styles.providerHead}>
                <span className={styles.providerIcon}>
                  <Icon name="cloud" />
                </span>
                <div>
                  <div className={styles.providerName}>
                    {PROVIDER_LABELS[p]}
                  </div>
                  <div className={styles.providerKind}>Cloud API</div>
                </div>
                <span
                  className={`${styles.badge} ${status.cls} ${styles.providerStatus}`}
                >
                  {status.label}
                </span>
              </div>
              <div className={styles.providerStats}>
                <div>
                  <div className={styles.providerStatValue}>{u.keys}</div>
                  <div className={styles.providerStatLabel}>Keys</div>
                </div>
                <div>
                  <div className={styles.providerStatValue}>
                    {m ? m.models.length : "—"}
                  </div>
                  <div className={styles.providerStatLabel}>Models</div>
                </div>
                <div>
                  <div className={styles.providerStatValue}>
                    {formatCount(u.requests)}
                  </div>
                  <div className={styles.providerStatLabel}>Requests</div>
                </div>
              </div>
              <div
                className={styles.providerNote}
                title={off ? undefined : (m?.error ?? undefined)}
              >
                {off
                  ? "Paused: requests are turned away until you resume it."
                  : (m?.error ?? `Default model: ${m?.default ?? "…"}`)}
              </div>
              {off ? (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setView("manage")}
                >
                  Manage <Icon name="arrow" />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => openInPlayground(p)}
                >
                  Open in Playground <Icon name="arrow" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.blockTitle}>Local agent CLIs</div>
      <div className={styles.providerGrid}>
        {LOCAL_PROVIDERS.map((p) => {
          const h = localAgent?.providers[p];
          const m = models?.[p];
          const lu = localUsageFor(p);
          const off = isPaused(p);
          const tight = tightestLimit(p);
          const status = off
            ? { label: "Paused", cls: styles.badgeWarning }
            : localAgentError || h?.error
              ? { label: "Gateway down", cls: styles.badgeDanger }
              : !h
                ? { label: "Checking…", cls: "" }
                : h.installed
                  ? { label: "Installed", cls: styles.badgeSuccess }
                  : { label: "Not installed", cls: "" };
          return (
            <div
              key={p}
              className={`${styles.providerCard} ${off ? styles.providerCardPaused : ""}`}
            >
              <div className={styles.providerHead}>
                <span className={styles.providerIcon}>
                  <Icon name={isWebProvider(p) ? "monitor" : "terminal"} />
                </span>
                <div>
                  <div className={styles.providerName}>
                    {PROVIDER_LABELS[p]}
                  </div>
                  <div className={styles.providerKind}>{localKind(p)}</div>
                </div>
                <span
                  className={`${styles.badge} ${status.cls} ${styles.providerStatus}`}
                >
                  {status.label}
                </span>
              </div>
              <div className={styles.providerStats}>
                <div>
                  <div className={styles.providerStatValue}>
                    {m ? (m.models.length ? m.models.length : "Any") : "—"}
                  </div>
                  <div className={styles.providerStatLabel}>Models</div>
                </div>
                <div>
                  <div className={styles.providerStatValue}>
                    {formatCount(lu.requests)}
                  </div>
                  <div className={styles.providerStatLabel}>Requests</div>
                </div>
                <div>
                  <div className={styles.providerStatValue}>
                    {localTokens(lu)}
                  </div>
                  <div className={styles.providerStatLabel}>Tokens</div>
                </div>
              </div>
              <div className={styles.providerNote}>
                {off
                  ? "Paused: requests are turned away until you resume it."
                  : (localAgentError ??
                    (h?.version ? `Version ${h.version}` : "Version unknown"))}
                {tight && (
                  <span
                    className={styles.providerLimit}
                    title={tight.models ?? undefined}
                  >
                    {tight.group ? `${tight.group}: ` : ""}
                    {Math.round(tight.remaining_fraction * 100)}% of the{" "}
                    {windowLabel(tight.window).toLowerCase()} limit left,
                    resets {resetLabel(tight.resets_at, now)}
                  </span>
                )}
              </div>
              {off ? (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setView("manage")}
                >
                  Manage <Icon name="arrow" />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => openInPlayground(p)}
                >
                  Open in Playground <Icon name="arrow" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.blockTitle}>Get started</div>
      <div className={styles.actionList}>
        <button
          type="button"
          className={styles.actionRow}
          onClick={() => setView("playground")}
        >
          <span className={styles.statIcon}>
            <Icon name="playground" />
          </span>
          <span>
            <span className={styles.actionTitle}>Open the Playground</span>
            <span className={styles.actionDesc}>
              Chat with any model, live
            </span>
          </span>
        </button>
        <button
          type="button"
          className={styles.actionRow}
          onClick={() => setView("api-keys")}
        >
          <span className={styles.statIcon}>
            <Icon name="key" />
          </span>
          <span>
            <span className={styles.actionTitle}>Create an API key</span>
            <span className={styles.actionDesc}>
              For an app or a person, with its own limits
            </span>
          </span>
        </button>
        <Link href="/documents" className={styles.actionRow}>
          <span className={styles.statIcon}>
            <Icon name="book" />
          </span>
          <span>
            <span className={styles.actionTitle}>Read the documentation</span>
            <span className={styles.actionDesc}>Requests, payloads, models</span>
          </span>
        </Link>
      </div>
    </>
  );

  const playgroundView = (
    <div className={styles.playground}>
      <div className={styles.playgroundMain}>
        <div
          className={styles.transcript}
          ref={transcriptRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {chatMessages.length === 0 && !chatBusy ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <Icon name="sparkle" />
              </div>
              <div className={styles.emptyTitle}>Start a conversation</div>
              <div className={styles.emptyDesc}>
                Messages go to {chatLabel}
                {modelSummary ? ` · ${modelSummary}` : ""}.
              </div>
              <div className={styles.chips}>
                {SUGGESTIONS[chatIsCloud ? "cloud" : "local"].map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={styles.chip}
                    onClick={() => setChatInput(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {chatMessages.map((m, i) => {
                const note = finishNote(m);
                return (
                  <div key={i} className={styles.turn}>
                    <div
                      className={`${styles.turnRole} ${
                        m.isError
                          ? styles.turnRoleError
                          : m.role === "user"
                            ? styles.turnRoleUser
                            : styles.turnRoleAssistant
                      }`}
                    >
                      {m.isError
                        ? "Error"
                        : m.role === "user"
                          ? "You"
                          : chatLabel}
                    </div>
                    {m.thinking && (
                      <details className={styles.thinkingDetails}>
                        <summary>Thinking</summary>
                        <div className={styles.thinkingText}>{m.thinking}</div>
                      </details>
                    )}
                    {m.content && (
                      <div
                        className={`${styles.turnContent} ${
                          m.isError ? styles.turnContentError : ""
                        }`}
                      >
                        {m.content}
                      </div>
                    )}
                    {note && <div className={styles.turnNote}>{note}</div>}
                  </div>
                );
              })}
              {chatBusy && (
                <div className={styles.turn}>
                  <div
                    className={`${styles.turnRole} ${styles.turnRoleAssistant}`}
                  >
                    {chatLabel}
                  </div>
                  {chatStreamingThinking && (
                    <div className={styles.thinkingLive}>
                      <div className={styles.thinkingHeader}>
                        {chatStreaming ? "Thought" : "Thinking…"}
                      </div>
                      <div className={styles.thinkingScroll}>
                        <div className={styles.thinkingText}>
                          {chatStreamingThinking}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className={styles.turnContent}>
                    {chatStreaming.trimStart()}
                    <span className={styles.typingCursor} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <form
          onSubmit={handleSendChat}
          className={styles.composer}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSendChat(e);
            }
          }}
        >
          {chatPaused && (
            <div className={styles.notice}>
              <span>{chatLabel} is paused.</span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setView("manage")}
              >
                Resume it on the Manage page <Icon name="arrow" />
              </button>
            </div>
          )}
          <div className={styles.composerBox}>
            <textarea
              className={styles.chatTextarea}
              rows={Math.min(8, Math.max(2, chatInput.split("\n").length))}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={`Message ${chatLabel}…`}
              disabled={chatBusy}
            />
            {chatBusy ? (
              <button
                type="button"
                className={`${styles.buttonGhost} ${styles.buttonStop}`}
                onClick={() => abortRef.current?.abort()}
              >
                <Icon name="stop" /> Stop
              </button>
            ) : (
              <button
                type="submit"
                className={styles.button}
                disabled={!chatInput.trim() || chatPaused}
              >
                Run <Icon name="send" />
              </button>
            )}
          </div>
          <div className={styles.runHint}>
            <span>Enter to run · Shift+Enter for a new line</span>
            <span>
              {chatLabel}
              {modelSummary ? ` · ${modelSummary}` : ""}
            </span>
          </div>
        </form>
      </div>

      <aside className={styles.playgroundSidebar}>
        <div className={styles.panelGroup}>
          <div className={styles.panelTitle}>Model</div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pg-provider">
              Provider
            </label>
            <select
              id="pg-provider"
              className={styles.select}
              value={chatProvider}
              disabled={chatBusy}
              onChange={(e) => selectProvider(e.target.value as ChatProvider)}
            >
              <optgroup label="Cloud APIs">
                {CLOUD_PROVIDERS.map((p) => (
                  <option key={p} value={p} disabled={isPaused(p)}>
                    {`${PROVIDER_LABELS[p]}${isPaused(p) ? " (paused)" : ""}`}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Local agent CLIs">
                {LOCAL_PROVIDERS.map((p) => (
                  <option key={p} value={p} disabled={isPaused(p)}>
                    {`${PROVIDER_LABELS[p]}${isPaused(p) ? " (paused)" : ""}`}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pg-model">
              Model
            </label>
            <select
              id="pg-model"
              className={styles.select}
              value={chatModel}
              disabled={chatBusy}
              onChange={(e) => setChatModel(e.target.value)}
            >
              <option value="">
                {chatIsCloud && providerModels?.default
                  ? `Default · ${providerModels.default}`
                  : "Default"}
              </option>
              {(providerModels?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                </option>
              ))}
              <option value={CUSTOM_MODEL}>Custom…</option>
            </select>
          </div>
          {chatModel === CUSTOM_MODEL && (
            <input
              className={styles.input}
              value={chatCustomModel}
              onChange={(e) => setChatCustomModel(e.target.value)}
              placeholder="Model id"
              disabled={chatBusy}
            />
          )}
          {!models && <p className={styles.sidebarHint}>Loading models…</p>}
          {providerModels?.note && (
            <p className={styles.sidebarHint}>
              {asSentence(providerModels.note)}
            </p>
          )}
          {providerModels?.error && (
            <p className={styles.sidebarHint}>
              Couldn&apos;t list models: {providerModels.error}
            </p>
          )}
        </div>

        <div className={styles.panelGroup}>
          <div className={styles.panelTitle}>Parameters</div>
          {chatIsCloud ? (
            <>
              <div className={styles.twoCol}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pg-max">
                    Max tokens
                  </label>
                  <input
                    id="pg-max"
                    className={styles.input}
                    type="number"
                    min={1}
                    value={chatMaxTokens}
                    onChange={(e) => setChatMaxTokens(e.target.value)}
                    placeholder="Default"
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="pg-temp">
                    Temperature
                  </label>
                  <input
                    id="pg-temp"
                    className={styles.input}
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={chatTemperature}
                    onChange={(e) => setChatTemperature(e.target.value)}
                    placeholder="Default"
                  />
                </div>
              </div>
              {chatProvider === "sea-lion" && (
                <>
                  <label className={styles.switchRow}>
                    <span>Thinking</span>
                    <input
                      type="checkbox"
                      className={styles.switch}
                      checked={chatThinking}
                      onChange={(e) => setChatThinking(e.target.checked)}
                    />
                  </label>
                  <p className={styles.sidebarHint}>
                    SEA-LION reasons before answering. Turn off for much faster
                    replies.
                  </p>
                </>
              )}
            </>
          ) : isWebProvider(chatProvider) ? (
            <p className={styles.sidebarHint}>
              Answered by {WEB_HOSTS[chatProvider]} in the gateway&apos;s Chrome
              window. This conversation is saved to the account&apos;s history
              so later turns can continue it.{" "}
              {chatProvider === "grok" ? (
                <>
                  The free plan has model <code>fast</code> only, which reasons
                  for 10–35 s before answering.
                </>
              ) : chatProvider === "mimo" ? (
                <>
                  Models <code>mimo-v2.6-pro</code> and{" "}
                  <code>mimo-v2.6-flash</code>; its reasoning streams live.
                </>
              ) : (
                <>
                  Model <code>think</code> turns on ChatGPT&apos;s Think.
                </>
              )}
            </p>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="pg-workdir">
                  Working directory
                </label>
                <input
                  id="pg-workdir"
                  className={styles.input}
                  value={chatWorkdir}
                  onChange={(e) => setChatWorkdir(e.target.value)}
                  placeholder="Gateway default"
                  disabled={chatBusy}
                />
              </div>
              <p className={styles.sidebarHint}>
                Absolute path inside the gateway&apos;s allowlist. The CLI can
                read files there.
              </p>
            </>
          )}
        </div>

        <div className={styles.panelGroup}>
          <div className={styles.panelTitle}>Session</div>
          <div className={styles.statList}>
            {chatIsCloud ? (
              <div className={styles.statListRow}>
                <span>History</span>
                <span>
                  {chatMessages.length} message
                  {chatMessages.length === 1 ? "" : "s"}
                </span>
              </div>
            ) : (
              <div className={styles.statListRow}>
                <span>Session</span>
                <span>
                  {chatSessionId ? `${chatSessionId.slice(0, 8)}…` : "new"}
                </span>
              </div>
            )}
            {chatLast?.model && (
              <div className={styles.statListRow}>
                <span>Answered by</span>
                <span>{chatLast.model}</span>
              </div>
            )}
            {chatLast?.usage && (
              <div className={styles.statListRow}>
                <span>Tokens</span>
                <span>
                  {chatLast.usage.prompt_tokens ?? "?"} in ·{" "}
                  {chatLast.usage.completion_tokens ?? "?"} out
                </span>
              </div>
            )}
            {chatLast?.duration_ms !== undefined && (
              <div className={styles.statListRow}>
                <span>Latency</span>
                <span>{(chatLast.duration_ms / 1000).toFixed(1)}s</span>
              </div>
            )}
            {chatLast?.finish_reason && (
              <div className={styles.statListRow}>
                <span>Stop reason</span>
                <span>{chatLast.finish_reason}</span>
              </div>
            )}
          </div>
          <p className={styles.sidebarHint}>
            {chatIsCloud
              ? "Stateless API: the whole conversation is sent with every message."
              : "The CLI keeps its own history; each message resumes the session."}
          </p>
          <button
            type="button"
            className={styles.buttonGhost}
            onClick={handleClearChat}
          >
            New session
          </button>
        </div>
      </aside>
    </div>
  );

  const apiKeysView = (
    <ApiKeys
      keys={tokens}
      publicOrigin={publicOrigin}
      providers={PROVIDER_OPTIONS}
      reload={loadTokens}
      now={tokensAt}
    />
  );

  // A provider's name on a stat card, with a badge when it's paused.
  const statTitle = (p: ChatProvider) => (
    <span className={styles.statTitle}>
      <span className={styles.statLabel}>{PROVIDER_LABELS[p]}</span>
      {isPaused(p) && (
        <span className={`${styles.badge} ${styles.badgeWarning}`}>Paused</span>
      )}
    </span>
  );

  const analyticsView = (
    <>
      <div className={styles.blockTitle}>Cloud APIs</div>
      <div className={styles.providerGrid}>
        {CLOUD_PROVIDERS.map((p) => {
          const u = usageFor(p);
          return (
            <div key={p} className={styles.statCard}>
              <div className={styles.statHead}>
                {statTitle(p)}
                <span className={styles.statIcon}>
                  <Icon name="cloud" />
                </span>
              </div>
              <div className={styles.statValue}>{formatCount(u.requests)}</div>
              <div className={styles.statSub}>
                requests today · {formatCount(u.tokens)} tokens ·{" "}
                {u.activeKeys} of {u.keys} keys active
              </div>
            </div>
          );
        })}
      </div>

      {keys === null && <p className={styles.empty}>Loading…</p>}
      {keys !== null && keys.length === 0 && (
        <p className={styles.empty}>No API keys configured.</p>
      )}

      {Object.entries(grouped).map(([provider, rows]) => {
        const visible = showIdleKeys
          ? rows
          : rows.filter((r) => r.requestsToday > 0 || r.requestsLast60s > 0);
        const keyCount = new Set(rows.map((r) => r.keyName)).size;
        return (
          <section key={provider} className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                {PROVIDER_LABELS[provider as ChatProvider] ?? provider}
              </span>
              <span className={`${styles.badge} ${styles.badgeAccent}`}>
                {keyCount} key{keyCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className={styles.tableWrap} style={{ marginTop: 12 }}>
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
                  {visible.map((r) => (
                    <tr key={`${r.keyName}:${r.model}`}>
                      <td className={styles.mono}>{r.keyName}</td>
                      <td className={styles.dim}>{r.model}</td>
                      <td style={{ minWidth: 140 }}>
                        <ProgressBar
                          used={r.requestsLast60s}
                          limit={r.limits?.requestsPerMin}
                        />
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <ProgressBar
                          used={r.tokensLast60s}
                          limit={r.limits?.tokensPerMin}
                        />
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <ProgressBar
                          used={r.requestsToday}
                          limit={r.limits?.requestsPerDay}
                        />
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <ProgressBar
                          used={r.tokensToday}
                          limit={r.limits?.tokensPerDay}
                        />
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr className={styles.idleRow}>
                      <td colSpan={6}>
                        No activity today across {keyCount} keys.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <div className={styles.blockTitle}>Local agent CLIs</div>
      <div className={styles.providerGrid}>
        {LOCAL_PROVIDERS.map((p) => {
          const lu = localUsageFor(p);
          const details = [
            "requests today",
            lu.requests > 0 && !lu.tokensReported
              ? "tokens not reported"
              : `${formatCount(lu.tokens)} tokens`,
            ...(lu.avgDurationMs !== null
              ? [`avg ${(lu.avgDurationMs / 1000).toFixed(1)}s`]
              : []),
            ...(lu.errors > 0 ? [`${lu.errors} failed`] : []),
          ];
          return (
            <div key={p} className={styles.statCard}>
              <div className={styles.statHead}>
                {statTitle(p)}
                <span className={styles.statIcon}>
                  <Icon name="terminal" />
                </span>
              </div>
              <div className={styles.statValue}>{formatCount(lu.requests)}</div>
              <div className={styles.statSub}>{details.join(" · ")}</div>
            </div>
          );
        })}
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Plan limits</span>
          {limitsCheckedAt && (
            <span className={styles.badge}>
              Checked {new Date(limitsCheckedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <p className={styles.sectionDesc}>
          How much of each subscription&apos;s usage limits is left, as the CLI
          itself reports it. Checking uses none of it. The limits belong to the
          account, so use outside Thun Murex counts too. They refill in 5-hour
          and weekly windows, not daily.
          {silentProviders.length > 0 &&
            ` ${listLabels(silentProviders)} ${
              silentProviders.length === 1 ? "doesn't" : "don't"
            } report ${silentProviders.length === 1 ? "its" : "their"} limits.`}
        </p>
        {planLimitsError && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {planLimitsError}
          </div>
        )}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>CLI</th>
                <th>Models</th>
                <th>Window</th>
                <th>Remaining</th>
                <th>Resets</th>
              </tr>
            </thead>
            <tbody>
              {limitProviders.flatMap((p) => {
                const report = planLimits?.[p];
                if (!report?.limits.length) {
                  return [
                    <tr key={p} className={styles.idleRow}>
                      <td>{PROVIDER_LABELS[p]}</td>
                      <td colSpan={4}>
                        {report?.error
                          ? asSentence(report.error)
                          : "Not checked yet."}
                      </td>
                    </tr>,
                  ];
                }
                return report.limits.map((l) => (
                  <tr key={`${p}:${l.id}`}>
                    <td>{PROVIDER_LABELS[p]}</td>
                    <td style={{ minWidth: 180 }}>
                      {l.group ?? "All models"}
                      {l.models && (
                        <div className={styles.dim}>{l.models}</div>
                      )}
                    </td>
                    <td>{windowLabel(l.window)}</td>
                    <td style={{ minWidth: 140 }}>
                      <RemainingBar fraction={l.remaining_fraction} />
                    </td>
                    <td className={styles.dim}>
                      {l.resets_at
                        ? resetLabel(l.resets_at, now)
                        : l.remaining_fraction >= 1
                          ? "Not started"
                          : "—"}
                    </td>
                  </tr>
                ));
              })}
              {planLimits !== null && limitProviders.length === 0 && (
                <tr className={styles.idleRow}>
                  <td colSpan={5}>No installed CLI reports its limits.</td>
                </tr>
              )}
              {planLimits === null && !planLimitsError && (
                <tr className={styles.idleRow}>
                  <td colSpan={5}>Checking…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Runs by model</span>
          <span className={`${styles.badge} ${styles.badgeAccent}`}>
            {(localUsage ?? []).length} model
            {(localUsage ?? []).length === 1 ? "" : "s"} used today
          </span>
        </div>
        <p className={styles.sectionDesc}>
          Every run, per CLI and model. Tokens are what the CLI reports for
          that run: Claude Code and Antigravity report them, Codex and Gemini
          don&apos;t. Input includes cached tokens, which are most of a Claude
          Code run.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>CLI</th>
                <th>Model</th>
                <th>Requests</th>
                <th>Failed</th>
                <th>Input tokens</th>
                <th>Output tokens</th>
                <th>Avg latency</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {(localUsage ?? []).map((r) => (
                <tr key={`${r.provider}:${r.model}`}>
                  <td>
                    {PROVIDER_LABELS[r.provider as ChatProvider] ?? r.provider}
                  </td>
                  <td className={styles.dim}>{r.model}</td>
                  <td>{r.requestsToday.toLocaleString()}</td>
                  <td className={styles.dim}>
                    {r.errorsToday.toLocaleString()}
                  </td>
                  <td>
                    {r.tokensReported
                      ? r.promptTokensToday.toLocaleString()
                      : "—"}
                  </td>
                  <td>
                    {r.tokensReported
                      ? r.completionTokensToday.toLocaleString()
                      : "—"}
                  </td>
                  <td className={styles.dim}>
                    {r.avgDurationMs !== null
                      ? `${(r.avgDurationMs / 1000).toFixed(1)}s`
                      : "—"}
                  </td>
                  <td className={styles.dim}>
                    {new Date(r.lastUsedAt).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
              {localUsage !== null && localUsage.length === 0 && (
                <tr className={styles.idleRow}>
                  <td colSpan={8}>No local CLI runs today.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className={styles.meta}>
        Refreshes every {REFRESH_MS / 1000}s. Daily totals are saved on the
        server and survive restarts; the per-minute columns start over when it
        restarts.
      </p>
    </>
  );

  const manageView = (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Providers</span>
          <span className={styles.badge}>
            {CLOUD_PROVIDERS.length + LOCAL_PROVIDERS.length - paused.length}{" "}
            active
            {paused.length > 0 ? ` · ${paused.length} paused` : ""}
          </span>
        </div>
        <p className={styles.sectionDesc}>
          Pausing a provider stops all traffic to it until you resume it, from
          the Playground and from apps using your access tokens alike: requests
          get HTTP 503. Its keys and CLI login stay as they are.
        </p>

        {pauseError && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {pauseError}
          </div>
        )}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Type</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS].map((p) => {
                const off = isPaused(p);
                return (
                  <tr key={p}>
                    <td>
                      {PROVIDER_LABELS[p]}{" "}
                      <span className={`${styles.mono} ${styles.dim}`}>
                        {p}
                      </span>
                    </td>
                    <td className={styles.dim}>
                      {isCloudProvider(p) ? "Cloud API" : localKind(p)}
                    </td>
                    <td>
                      <span
                        className={`${styles.badge} ${
                          off ? styles.badgeWarning : styles.badgeSuccess
                        }`}
                      >
                        {off ? "Paused" : "Active"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        disabled={pauseBusy !== null}
                        onClick={() => handleTogglePause(p, !off)}
                      >
                        <Icon name={off ? "play" : "pause"} />
                        {pauseBusy === p ? "Saving…" : off ? "Resume" : "Pause"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>API reference</span>
        </div>
        <p className={styles.sectionDesc}>
          Send <code>Authorization: Bearer</code> with your APP_API_KEY or an
          access token, and a JSON body. <code>/api/chat</code> returns one JSON
          response; <code>/api/chat/stream</code> takes the same body and
          streams Server-Sent Events. The examples read the key from{" "}
          <code>$AI_THUN_KEY</code>: set it first, with{" "}
          <code>export AI_THUN_KEY=…</code>. Every endpoint, field and
          response is in the{" "}
          <Link href="/documents" className={styles.inlineLink}>
            documentation
          </Link>
          .
        </p>

        <div className={styles.codeBlock}>
          <div className={styles.codeBlockLabel}>Basic request</div>
          <div className={styles.codeBlockBody}>
            <pre className={styles.pre}>{`curl -X POST ${origin}/api/chat \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "Hello!"}'`}</pre>
            <CopyButton
              value={`curl -X POST ${origin}/api/chat \\\n  -H "Authorization: Bearer $AI_THUN_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "Hello!"}'`}
            />
          </div>
        </div>

        <div className={styles.codeBlock}>
          <div className={styles.codeBlockLabel}>
            Choosing a provider &amp; model
          </div>
          <div className={styles.codeBlockBody}>
            <pre className={styles.pre}>{`curl -X POST ${origin}/api/chat \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "groq", "model": "openai/gpt-oss-120b", "prompt": "Hello!"}'`}</pre>
            <CopyButton
              value={`curl -X POST ${origin}/api/chat \\\n  -H "Authorization: Bearer $AI_THUN_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"provider": "groq", "model": "openai/gpt-oss-120b", "prompt": "Hello!"}'`}
            />
          </div>
        </div>

        <div className={styles.codeBlock}>
          <div className={styles.codeBlockLabel}>Listing models</div>
          <div className={styles.codeBlockBody}>
            <pre className={styles.pre}>{`curl ${origin}/api/models \\
  -H "Authorization: Bearer $AI_THUN_KEY"`}</pre>
            <CopyButton
              value={`curl ${origin}/api/models \\\n  -H "Authorization: Bearer $AI_THUN_KEY"`}
            />
          </div>
        </div>

        <table className={styles.refTable}>
          <tbody>
            <tr>
              <td className={styles.mono}>provider</td>
              <td className={styles.dim}>
                Optional, default <code>sea-lion</code>. Cloud:{" "}
                <code>sea-lion</code>, <code>cerebras</code>, <code>groq</code>.
                Local CLIs: <code>claude</code>, <code>codex</code>,{" "}
                <code>gemini</code>, <code>antigravity</code>. Websites:{" "}
                <code>chatgpt</code>, <code>grok</code>, <code>mimo</code>.
              </td>
            </tr>
            <tr>
              <td className={styles.mono}>model</td>
              <td className={styles.dim}>
                Optional — any id from <code>/api/models</code>; falls back to
                the provider&apos;s default.
              </td>
            </tr>
            <tr>
              <td className={styles.mono}>prompt / messages</td>
              <td className={styles.dim}>
                <code>prompt</code> is one user message;{" "}
                <code>messages</code> is an OpenAI-style array for multi-turn
                context. The reply is at{" "}
                <code>choices[0].message.content</code>.
              </td>
            </tr>
            <tr>
              <td className={styles.mono}>session_id, workdir</td>
              <td className={styles.dim}>
                Local CLIs only: resume an earlier session, and the directory
                the CLI may read. The websites take session_id only.
              </td>
            </tr>
            <tr>
              <td className={styles.mono}>temporary</td>
              <td className={styles.dim}>
                <code>chatgpt</code> and <code>grok</code> only. Default{" "}
                <code>true</code>: a temporary (ChatGPT) or private (Grok) chat,
                kept out of the account&apos;s history, that can&apos;t be
                continued. <code>false</code> saves it and returns a session_id.
                MiMo has no such chats: it always saves.
              </td>
            </tr>
            <tr>
              <td className={styles.mono}>max_tokens, temperature, …</td>
              <td className={styles.dim}>
                Cloud only: any other OpenAI-compatible field is forwarded as
                is. SEA-LION:{" "}
                <code>{`"chat_template_kwargs": {"enable_thinking": false}`}</code>{" "}
                turns reasoning off.
              </td>
            </tr>
            <tr>
              <td className={styles.mono}>HTTP 503</td>
              <td className={styles.dim}>
                The provider is paused (see Providers above).
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Local agent CLIs</span>
          <span className={styles.badge}>
            {installedClis} of {LOCAL_PROVIDERS.length} installed
          </span>
        </div>
        <p className={styles.sectionDesc}>
          Real coding-CLI subprocesses on this machine, run by
          local-agent-gateway with read access to an allowlisted working
          directory. Installed isn&apos;t the same as signed in — each CLI
          needs its own login on this machine. ChatGPT, Grok and MiMo (web)
          are chatgpt-web-gateway instead: their websites in its own signed-in
          Chrome window (installed here means Chrome is).
        </p>

        {localAgentError && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {localAgentError}
          </div>
        )}

        {localAgent && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Resume</th>
                  <th>Images</th>
                  <th>no_tools</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(localAgent.providers).map(([name, p]) => (
                  <tr key={name}>
                    <td>
                      {PROVIDER_LABELS[name as ChatProvider] ?? name}{" "}
                      <span className={`${styles.mono} ${styles.dim}`}>
                        {name}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`${styles.badge} ${
                          p.installed ? styles.badgeSuccess : p.error ? styles.badgeDanger : ""
                        }`}
                        title={p.error ?? undefined}
                      >
                        {p.installed ? "Installed" : p.error ? "Gateway down" : "Not installed"}
                      </span>
                    </td>
                    <td className={styles.dim}>{p.version ?? "—"}</td>
                    <td className={styles.dim}>
                      {p.supports_resume ? "Yes" : "No"}
                    </td>
                    <td className={styles.dim}>
                      {p.supports_images ? "Yes" : "No"}
                    </td>
                    <td className={styles.dim}>
                      {p.supports_no_tools ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!localAgent && !localAgentError && (
          <p className={styles.empty}>Loading…</p>
        )}
      </section>
    </>
  );

  const pageActions: ReactNode =
    view === "dashboard" ? (
      <button
        type="button"
        className={styles.button}
        onClick={() => setView("playground")}
      >
        Open Playground <Icon name="arrow" />
      </button>
    ) : view === "analytics" ? (
      <label className={styles.switchRow}>
        <span>Show idle keys</span>
        <input
          type="checkbox"
          className={styles.switch}
          checked={showIdleKeys}
          onChange={(e) => setShowIdleKeys(e.target.checked)}
        />
      </label>
    ) : null;

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <div className={`${styles.brand} ${styles.sidebarBrand}`}>
          <Logo className={styles.brandMark} />
          <span className={styles.brandText}>
            <span className={styles.brandName}>Thun Murex</span>
            <span className={styles.brandSub}>AI gateway</span>
          </span>
        </div>

        <div className={styles.navLabel}>Console</div>
        <nav className={styles.nav}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.navItem} ${
                view === item.id ? styles.navItemActive : ""
              }`}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} className={styles.navIcon} />
              {item.label}
            </button>
          ))}
          <Link href="/documents" className={styles.navItem}>
            <Icon name="book" className={styles.navIcon} />
            Documents
          </Link>
        </nav>

        <div className={styles.navFooter}>
          <div
            className={styles.themeSwitch}
            role="radiogroup"
            aria-label="Theme"
          >
            {(
              [
                ["system", "monitor", "Auto"],
                ["light", "sun", "Light"],
                ["dark", "moon", "Dark"],
              ] as const
            ).map(([value, icon, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                className={`${styles.themeOption} ${
                  theme === value ? styles.themeOptionActive : ""
                }`}
                onClick={() => setThemePref(value)}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.navItem} onClick={signOut}>
            <Icon name="logout" className={styles.navIcon} />
            Sign out
          </button>
        </div>
      </aside>

      <main className={styles.content}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>{currentNav.label}</h1>
            <p className={styles.pageDesc}>{currentNav.description}</p>
          </div>
          <div className={styles.pageActions}>
            {generatedAt && (
              <span className={styles.meta}>
                <span className={styles.liveDot} />
                Updated {new Date(generatedAt).toLocaleTimeString()}
              </span>
            )}
            {pageActions}
          </div>
        </div>

        {error && (
          <div className={styles.alert} style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {view === "dashboard" && dashboardView}
        {view === "playground" && playgroundView}
        {view === "api-keys" && apiKeysView}
        {view === "users" && <Users providers={PROVIDER_OPTIONS} />}
        {view === "codes" && <Codes providers={PROVIDER_OPTIONS} />}
        {view === "shop" && <Shop providers={PROVIDER_OPTIONS} />}
        {view === "analytics" && analyticsView}
        {view === "manage" && manageView}
      </main>
    </div>
  );
}
