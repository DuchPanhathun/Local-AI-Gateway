import { calculateUsageCost, type UsageCost } from "./pricing";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import type { RedeemCode } from "./redeem-codes";
import type { Shop } from "./shop";
import { statePath, writeJsonAtomic, writeJsonAtomicSync } from "./state-files";

// Access tokens: API keys for other people and apps, and the accounts of the
// people who signed up (lib/supabase.ts). A key the owner makes on the API
// keys page has its own limits, expiry, providers and usage. An account's
// keys, which its holder makes on /account, share the account's: its plan,
// set by the owner on the Users page, and its usage, which stays when a key
// is deleted. Kept in the state folder (tokens.json), like the usage ledger,
// so restarts and deploys keep them. Only a SHA-256 hash of each key is
// stored: the key itself is shown once, when it's made (or made again).
//
// Usage is counted per key (and account), UTC day, provider and model. Held
// in memory and saved a second after each change and again on shutdown;
// changes the owner makes are saved before they're answered.

const TOKENS_FILE = statePath("tokens.json");
const SAVE_DELAY_MS = 1_000;
const KEEP_DAYS = 400; // per-day usage; the all-time totals are kept for good
const KEY_PREFIX = "sk-ai-thun-";
const IMPORT_RETRY_MS = 60_000;
export const DEFAULT_MAX_KEYS = 5;

export type Period = "day" | "month" | "total";
export const PERIODS: readonly Period[] = ["day", "month", "total"];

export type KeyLimits = {
  // What `tokens` and `requests` count over: the UTC day, the UTC month, or
  // all time (a prepaid amount, topped up by raising it).
  period: Period;
  tokens: number | null; // null: no limit
  requests: number | null;
  perMinute: number | null; // requests in any 60 seconds
};

export type Counts = {
  requests: number;
  errors: number; // failed requests: counted here, but not against the limits
  tokens: number;
  estimatedTokens: number; // the part of `tokens` guessed from text length
};

type DayUsage = Counts & {
  providers: Record<string, Record<string, Counts>>; // provider → model → counts
};

// What a key may use, and what it has used: a key's own, or its account's.
export type Allowance = {
  disabled: boolean;
  expiresAt: string | null;
  limits: KeyLimits;
  providers: string[] | null; // null: every provider
  // The local CLIs with their tools, which read files on this machine, in a
  // workdir of the caller's choosing, and /api/image. Off: Claude Code and
  // Codex answer without tools, and Gemini CLI, Antigravity and images are
  // refused.
  agentTools: boolean;
  lastUsedAt: string | null;
  total: Counts;
  days: Record<string, DayUsage>;
};

export type ApiToken = Allowance & {
  id: string;
  name: string;
  note: string; // the owner's own: never shown to the key's holder
  hash: string; // SHA-256 of the key, hex
  hint: string; // "sk-ai-thun-ab12…cd34"
  createdAt: string;
  // An account's key: the account's allowance applies, and this one's
  // limits and expiry don't. It can still be turned off on its own.
  userId: string | null;
};

export type CreditTransaction = {
  id: string;
  userId: string;
  type: "deposit" | "usage" | "refund" | "adjustment";
  amountCents: number; // positive for deposits, negative for deductions
  amountUSD: number;
  balanceAfterCents: number;
  balanceAfterUSD: number;
  description: string;
  orderId?: string | null;
  createdAt: string;
};

export type Account = Allowance & {
  userId: string; // the Supabase user
  email: string; // as of the last time they signed in
  note: string; // the owner's own
  createdAt: string;
  activatedAt: string | null; // null: waiting for the owner, and its keys don't work
  maxKeys: number;
  balance: number; // in USD (credits)
  creditBalance: number; // alias for balance
  creditBalanceCents: number; // balance in cents (e.g. 500 for $5.00)
  transactions?: CreditTransaction[];
};

export type TokenFile = {
  version: 1;
  // Tokens from when ai-thun ran on Vercel were kept in Edge Config; they're
  // brought over once.
  importedFromEdgeConfig: boolean;
  tokens: ApiToken[];
  accounts: Account[];
  codes: RedeemCode[]; // lib/redeem-codes.ts
  shop?: Shop; // lib/shop.ts fills it in
};

type Store = {
  file: TokenFile;
  changes: number; // bumped on every change
  savedChanges: number; // `changes` as of the last completed save
  timer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void>;
  importing: Promise<void> | null;
  importRetryAt: number;
  recent: Map<string, number[]>; // request times in the last minute, by key id or "account:<id>"
};

const DEFAULT_LIMITS: KeyLimits = { period: "month", tokens: null, requests: null, perMinute: null };

function emptyCounts(): Counts {
  return { requests: 0, errors: 0, tokens: 0, estimatedTokens: 0 };
}

function addCounts(to: Counts, from: Counts): void {
  to.requests += from.requests ?? 0;
  to.errors += from.errors ?? 0;
  to.tokens += from.tokens ?? 0;
  to.estimatedTokens += from.estimatedTokens ?? 0;
}

export function hashOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function hintOf(key: string): string {
  return `${key.slice(0, KEY_PREFIX.length + 4)}…${key.slice(-4)}`;
}

function newSecret(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
}

// An allowance read from the file, with any field an older file lacks filled in.
function normalizeAllowance(a: Partial<Allowance>): Allowance {
  return {
    disabled: Boolean(a.disabled),
    expiresAt: a.expiresAt ?? null,
    limits: { ...DEFAULT_LIMITS, ...a.limits },
    providers: Array.isArray(a.providers) ? a.providers : null,
    agentTools: Boolean(a.agentTools),
    lastUsedAt: a.lastUsedAt ?? null,
    total: { ...emptyCounts(), ...a.total },
    days: a.days ?? {},
  };
}

function normalize(t: Partial<ApiToken>): ApiToken {
  return {
    ...normalizeAllowance(t),
    id: String(t.id),
    name: t.name ?? "untitled",
    note: t.note ?? "",
    hash: String(t.hash),
    hint: t.hint ?? "",
    createdAt: t.createdAt ?? new Date(0).toISOString(),
    userId: t.userId ?? null,
  };
}

function normalizeAccount(a: Partial<Account>): Account {
  const credit =
    typeof a.creditBalance === "number"
      ? a.creditBalance
      : typeof a.balance === "number"
        ? a.balance
        : typeof (a as { creditBalanceCents?: number }).creditBalanceCents === "number"
          ? (a as { creditBalanceCents: number }).creditBalanceCents / 100
          : 0;
  const cents =
    typeof (a as { creditBalanceCents?: number }).creditBalanceCents === "number"
      ? (a as { creditBalanceCents: number }).creditBalanceCents
      : Math.round(credit * 100);
  return {
    ...normalizeAllowance(a),
    userId: String(a.userId),
    email: a.email ?? "",
    note: a.note ?? "",
    createdAt: a.createdAt ?? new Date(0).toISOString(),
    activatedAt: a.activatedAt ?? null,
    maxKeys: typeof a.maxKeys === "number" ? a.maxKeys : DEFAULT_MAX_KEYS,
    balance: credit,
    creditBalance: credit,
    creditBalanceCents: cents,
    transactions: Array.isArray(a.transactions) ? a.transactions : [],
  };
}

function emptyFile(): TokenFile {
  return { version: 1, importedFromEdgeConfig: false, tokens: [], accounts: [], codes: [] };
}

function load(): TokenFile {
  let raw: string;
  try {
    raw = readFileSync(TOKENS_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Can't read ${TOKENS_FILE}:`, err);
    }
    return emptyFile();
  }
  try {
    const data = JSON.parse(raw) as Partial<TokenFile>;
    if (!Array.isArray(data.tokens)) throw new Error("it has no `tokens`");
    return {
      version: 1,
      importedFromEdgeConfig: Boolean(data.importedFromEdgeConfig),
      tokens: data.tokens.map(normalize),
      accounts: (data.accounts ?? []).map(normalizeAccount),
      codes: Array.isArray(data.codes) ? data.codes : [],
      ...(data.shop ? { shop: data.shop } : {}),
    };
  } catch (err) {
    // Set the unreadable file aside rather than overwrite it on the next save.
    const aside = `${TOKENS_FILE}.unreadable-${Date.now()}`;
    try {
      renameSync(TOKENS_FILE, aside);
    } catch {}
    console.error(`${TOKENS_FILE} isn't a token list; moved it to ${aside}:`, err);
    return emptyFile();
  }
}

// One store per process, even if the bundler hands several routes their own
// copy of this module.
const globalRef = globalThis as typeof globalThis & { __aiThunTokenStore?: Store };

function store(): Store {
  if (!globalRef.__aiThunTokenStore) {
    globalRef.__aiThunTokenStore = {
      file: load(),
      changes: 0,
      savedChanges: 0,
      timer: null,
      saving: Promise.resolve(),
      importing: null,
      importRetryAt: 0,
      recent: new Map(),
    };
    process.once("exit", saveBeforeExit);
  }
  return globalRef.__aiThunTokenStore;
}

async function save(s: Store): Promise<void> {
  const upTo = s.changes;
  if (upTo === s.savedChanges) return;
  await writeJsonAtomic(TOKENS_FILE, s.file);
  s.savedChanges = Math.max(s.savedChanges, upTo);
}

function scheduleSave(s: Store): void {
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    s.saving = s.saving
      .then(() => save(s))
      .catch((err) => console.error("Couldn't save the access tokens (will retry on the next change):", err));
  }, SAVE_DELAY_MS);
  (s.timer as { unref?: () => void }).unref?.();
}

// For the owner's changes: saved before they're answered, and a failed save
// is an error they see.
async function saveNow(s: Store): Promise<void> {
  s.changes += 1;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  const run = s.saving.then(() => save(s));
  s.saving = run.catch(() => {});
  await run;
}

function saveBeforeExit(): void {
  const s = globalRef.__aiThunTokenStore;
  if (!s || s.changes === s.savedChanges) return;
  try {
    writeJsonAtomicSync(TOKENS_FILE, s.file);
  } catch (err) {
    console.error("Couldn't save the access tokens on exit:", err);
  }
}

async function importFromEdgeConfig(s: Store, base: string): Promise<void> {
  const [url, query] = base.split("?");
  const res = await fetch(`${url}/item/apiTokens?${query}`, { cache: "no-store" });
  if (!res.ok && res.status !== 404) throw new Error(`Edge Config read failed: HTTP ${res.status}`);
  const old: unknown = res.status === 404 ? [] : await res.json();
  for (const t of Array.isArray(old) ? old : []) {
    const { id, token, label, createdAt } = t as { id?: string; token?: string; label?: string; createdAt?: string };
    if (typeof token !== "string" || s.file.tokens.some((k) => k.hash === hashOf(token))) continue;
    // With no limits and the access every token had then.
    s.file.tokens.push(
      normalize({
        id: id || randomBytes(8).toString("hex"),
        name: label || "untitled",
        hash: hashOf(token),
        hint: hintOf(token),
        createdAt,
        agentTools: true,
      })
    );
  }
  s.file.importedFromEdgeConfig = true;
  await saveNow(s);
}

// The store, once any tokens still in Edge Config have been brought over. If
// that fails, they don't work yet (the owner's key does), and it's tried
// again a minute later.
async function ready(): Promise<Store> {
  const s = store();
  const base = process.env.EDGE_CONFIG;
  if (s.file.importedFromEdgeConfig || !base) return s;
  if (!s.importing && Date.now() >= s.importRetryAt) {
    s.importing = importFromEdgeConfig(s, base)
      .catch((err) => {
        s.importRetryAt = Date.now() + IMPORT_RETRY_MS;
        console.error("Couldn't bring the access tokens over from Edge Config (will try again):", err);
      })
      .finally(() => {
        s.importing = null;
      });
  }
  await s.importing;
  return s;
}

function accountIn(s: Store, userId: string): Account | null {
  return s.file.accounts.find((a) => a.userId === userId) ?? null;
}

// ---------------------------------------------------------------------------
// Checking a key
// ---------------------------------------------------------------------------

export async function findKey(bearer: string): Promise<ApiToken | null> {
  if (!bearer.startsWith(KEY_PREFIX)) return null;
  const s = await ready();
  // Comparing hashes doesn't need to be constant-time: how much of a hash
  // matches says nothing about the key.
  const hash = hashOf(bearer);
  return s.file.tokens.find((t) => t.hash === hash) ?? null;
}

// The allowance that applies to a key: its account's, or its own. Null for
// an account's key whose account is gone.
export function allowanceOf(key: ApiToken): Allowance | null {
  return key.userId ? accountIn(store(), key.userId) : key;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// When the current period's counts start over, or null for "total".
export function resetsAt(period: Period, now = new Date()): string | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === "day") return new Date(Date.UTC(y, m, now.getUTCDate() + 1)).toISOString();
  if (period === "month") return new Date(Date.UTC(y, m + 1, 1)).toISOString();
  return null;
}

// What has been used in the current period.
export function usedInPeriod(a: Allowance, now = new Date()): Counts {
  if (a.limits.period === "total") return { ...a.total };
  const today = utcDay(now);
  const prefix = a.limits.period === "day" ? today : today.slice(0, 7);
  const used = emptyCounts();
  for (const [day, usage] of Object.entries(a.days)) {
    if (day.startsWith(prefix)) addCounts(used, usage);
  }
  return used;
}

// Requests that count against the limit: failed ones don't.
function counted(c: Counts): number {
  return c.requests - c.errors;
}

export type KeyStatus = "active" | "pending" | "disabled" | "expired" | "limited";

export type KeyBlock = { status: 403 | 429; error: string; retryAfter?: number };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function whenUTC(iso: string): string {
  return `${dateFormat.format(new Date(iso))} UTC`;
}

// Why the allowance can't be used right now, or null when it can. `noun`
// names it in the message: "API key" or "account".
export function blockOf(a: Allowance, now = Date.now(), noun = "API key"): KeyBlock | null {
  if (a.disabled) return { status: 403, error: `This ${noun} is turned off.` };
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) {
    return { status: 403, error: `This ${noun} expired on ${whenUTC(a.expiresAt)}.` };
  }
  const { period, tokens, requests } = a.limits;
  const used = usedInPeriod(a, new Date(now));
  const over =
    tokens !== null && used.tokens >= tokens
      ? `${tokens.toLocaleString("en")} tokens`
      : requests !== null && counted(used) >= requests
        ? `${requests.toLocaleString("en")} requests`
        : null;
  if (!over) return null;
  const reset = resetsAt(period, new Date(now));
  if (!reset) return { status: 429, error: `This ${noun} has used all of its ${over}.` };
  return {
    status: 429,
    error: `This ${noun} has used its ${over} for ${period === "day" ? "today" : "this month"}. They come back on ${whenUTC(reset)}.`,
    retryAfter: Math.ceil((Date.parse(reset) - now) / 1000),
  };
}

export function statusOf(a: Allowance, now = Date.now()): KeyStatus {
  if ("activatedAt" in a && !(a as Account).activatedAt) return "pending";
  if (a.disabled) return "disabled";
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return "expired";
  return blockOf(a, now) ? "limited" : "active";
}

// Lets one request through, or says why not. Counts it toward the
// per-minute limit, which an account's keys share (held in memory: a restart
// forgives).
export function admit(key: ApiToken, now = Date.now()): KeyBlock | null {
  if (key.disabled) return { status: 403, error: "This API key is turned off." };
  const s = store();
  let allowance: Allowance = key;
  let hasCredit = false;
  if (key.userId) {
    const account = accountIn(s, key.userId);
    if (!account) return { status: 403, error: "This API key's account no longer exists." };
    hasCredit = (account.creditBalance ?? account.balance ?? 0) > 0;
    if (!account.activatedAt && !hasCredit) return { status: 403, error: "This API key's account hasn't been activated yet." };
    allowance = account;
  }
  const blocked = blockOf(allowance, now, key.userId ? "account" : "API key");
  if (blocked) {
    if (allowance.disabled) return blocked;
    if (!hasCredit) return blocked;
  }
  const bucket = key.userId ? `account:${key.userId}` : key.id;
  const times = (s.recent.get(bucket) ?? []).filter((t) => t > now - 60_000);
  const perMinute = allowance.limits.perMinute;
  if (perMinute !== null && times.length >= perMinute) {
    s.recent.set(bucket, times);
    return {
      status: 429,
      error: `This ${key.userId ? "account" : "API key"} is limited to ${perMinute.toLocaleString("en")} requests a minute.`,
      retryAfter: Math.max(1, Math.ceil((times[0] + 60_000 - now) / 1000)),
    };
  }
  if (perMinute !== null) s.recent.set(bucket, [...times, now]);
  return null;
}

// ---------------------------------------------------------------------------
// Counting usage
// ---------------------------------------------------------------------------

// About 4 characters a token, for English; text in other scripts usually
// takes more tokens than this guesses.
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function addUsage(a: Allowance, provider: string, model: string, used: Counts, now: Date): void {
  const today = utcDay(now);
  if (!a.days[today]) {
    const cutoff = utcDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
    for (const day of Object.keys(a.days)) if (day < cutoff) delete a.days[day];
  }
  const day = (a.days[today] ??= { ...emptyCounts(), providers: {} });
  const byModel = (day.providers[provider] ??= {});
  addCounts((byModel[model] ??= emptyCounts()), used);
  addCounts(day, used);
  addCounts(a.total, used);
  a.lastUsedAt = now.toISOString();
}

// One request made with key `id`. `tokens`: what the provider reported, or
// null when it didn't say, and they're estimated from `textChars` (the
// prompt and answer) instead. An account's key counts for the account too.
export function recordKeyUsage(
  id: string,
  provider: string,
  model: string,
  outcome: { failed: boolean; tokens: number | null; textChars?: number }
): void {
  const s = store();
  const key = s.file.tokens.find((t) => t.id === id);
  if (!key) return; // deleted while the request ran
  const estimated = outcome.tokens === null && !outcome.failed ? estimateTokens(outcome.textChars ?? 0) : 0;
  const used: Counts = {
    requests: 1,
    errors: outcome.failed ? 1 : 0,
    tokens: (outcome.tokens ?? 0) + estimated,
    estimatedTokens: estimated,
  };
  const now = new Date();
  addUsage(key, provider, model, used, now);
  const account = key.userId ? accountIn(s, key.userId) : null;
  if (account) addUsage(account, provider, model, used, now);
  s.changes += 1;
  scheduleSave(s);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type AllowanceSummary = {
  status: KeyStatus;
  disabled: boolean;
  expiresAt: string | null;
  limits: KeyLimits;
  providers: string[] | null;
  agentTools: boolean;
  lastUsedAt: string | null;
  // The current period: today, this month (UTC), or all time.
  used: Counts;
  remaining: { tokens: number | null; requests: number | null }; // null: no limit
  resetsAt: string | null;
  total: Counts;
  balance?: number;
  creditBalance?: number;
  creditBalanceCents?: number;
};

function summarizeAllowance(a: Allowance, now: Date): AllowanceSummary {
  const used = usedInPeriod(a, now);
  const { tokens, requests } = a.limits;
  const credit =
    "creditBalance" in a
      ? (a as Account).creditBalance ?? (a as Account).balance ?? 0
      : "balance" in a
        ? (a as Account).balance ?? 0
        : undefined;
  const cents =
    "creditBalanceCents" in a
      ? (a as Account).creditBalanceCents ?? (credit !== undefined ? Math.round(credit * 100) : 0)
      : credit !== undefined
        ? Math.round(credit * 100)
        : undefined;
  return {
    status: statusOf(a, now.getTime()),
    disabled: a.disabled,
    expiresAt: a.expiresAt,
    limits: { ...a.limits },
    providers: a.providers ? [...a.providers] : null,
    agentTools: a.agentTools,
    lastUsedAt: a.lastUsedAt,
    used,
    remaining: {
      tokens: tokens === null ? null : Math.max(0, tokens - used.tokens),
      requests: requests === null ? null : Math.max(0, requests - counted(used)),
    },
    resetsAt: resetsAt(a.limits.period, now),
    total: { ...a.total },
    ...(credit !== undefined
      ? { balance: credit, creditBalance: credit, creditBalanceCents: cents }
      : {}),
  };
}

export type KeySummary = AllowanceSummary & {
  id: string;
  name: string;
  note: string;
  hint: string;
  createdAt: string;
  userId: string | null;
};

// A key with the allowance that applies to it (for an account's key, the
// account's, but the key's own on/off switch and last use).
export function summarize(key: ApiToken, now = new Date()): KeySummary {
  const account = key.userId ? accountIn(store(), key.userId) : null;
  const allowance = summarizeAllowance(account ?? key, now);
  return {
    ...allowance,
    ...(key.disabled ? { status: "disabled" as const, disabled: true } : {}),
    lastUsedAt: key.lastUsedAt,
    id: key.id,
    name: key.name,
    note: key.note,
    hint: key.hint,
    createdAt: key.createdAt,
    userId: key.userId,
  };
}

// An account's key, as its holder sees it in their dashboard: its own use.
export function ownKeySummary(key: ApiToken) {
  return {
    id: key.id,
    name: key.name,
    hint: key.hint,
    createdAt: key.createdAt,
    disabled: key.disabled,
    lastUsedAt: key.lastUsedAt,
    total: { ...key.total },
  };
}

// What the key's holder sees (GET /api/me): no id, and not the owner's note.
export function holderView(key: ApiToken, now = new Date()) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, note: _note, userId, ...rest } = summarize(key, now);
  return { ...rest, account: userId !== null };
}

export type AccountSummary = AllowanceSummary & {
  userId: string;
  email: string;
  note: string;
  createdAt: string;
  activatedAt: string | null;
  maxKeys: number;
  keyCount: number;
  balance: number;
  creditBalance: number;
  creditBalanceCents: number;
  transactions?: CreditTransaction[];
};

export function summarizeAccount(account: Account, now = new Date()): AccountSummary {
  const credit = account.creditBalance ?? account.balance ?? 0;
  const cents = account.creditBalanceCents ?? Math.round(credit * 100);
  return {
    ...summarizeAllowance(account, now),
    userId: account.userId,
    email: account.email,
    note: account.note,
    createdAt: account.createdAt,
    activatedAt: account.activatedAt,
    maxKeys: account.maxKeys,
    keyCount: store().file.tokens.filter((t) => t.userId === account.userId).length,
    balance: credit,
    creditBalance: credit,
    creditBalanceCents: cents,
    transactions: (account.transactions ?? []).slice(-50).reverse(),
  };
}

export type MonthUsage = {
  month: string;
  totals: Counts;
  days: { day: string; requests: number; tokens: number }[]; // every day of the month
  models: (Counts & { provider: string; model: string })[]; // most tokens first
};

// `month` is "2026-10" (UTC).
export function monthUsage(a: Allowance, month: string): MonthUsage {
  const [year, mon] = month.split("-").map(Number);
  const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const totals = emptyCounts();
  const models = new Map<string, Counts & { provider: string; model: string }>();
  const days = Array.from({ length }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, "0")}`;
    const usage = a.days[day];
    if (!usage) return { day, requests: 0, tokens: 0 };
    addCounts(totals, usage);
    for (const [provider, byModel] of Object.entries(usage.providers)) {
      for (const [model, c] of Object.entries(byModel)) {
        const id = JSON.stringify([provider, model]);
        let m = models.get(id);
        if (!m) models.set(id, (m = { provider, model, ...emptyCounts() }));
        addCounts(m, c);
      }
    }
    return { day, requests: usage.requests, tokens: usage.tokens };
  });
  return {
    month,
    totals,
    days,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests),
  };
}

// The months there's usage in, and the current one, newest first.
export function usageMonths(a: Allowance, now = new Date()): string[] {
  const months = new Set([utcDay(now).slice(0, 7), ...Object.keys(a.days).map((day) => day.slice(0, 7))]);
  return [...months].sort().reverse();
}

export async function listKeys(): Promise<ApiToken[]> {
  return (await ready()).file.tokens;
}

export async function getKey(id: string): Promise<ApiToken | null> {
  return (await ready()).file.tokens.find((t) => t.id === id) ?? null;
}

export async function listAccounts(): Promise<Account[]> {
  return (await ready()).file.accounts;
}

export async function getAccount(userId: string): Promise<Account | null> {
  return accountIn(await ready(), userId);
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export type KeySettings = {
  name?: string;
  note?: string;
  disabled?: boolean;
  expiresAt?: string | null;
  limits?: Partial<KeyLimits>;
  providers?: string[] | null;
  agentTools?: boolean;
};

export type KeyChanges = KeySettings & {
  addTokens?: number; // raise the token limit by this much
  addRequests?: number;
  extendDays?: number; // push the expiry this many days later (from now, if it's past)
  rotate?: boolean; // a new key; the old one stops working
  activate?: boolean; // accounts: let its keys work (or, false, not yet)
  maxKeys?: number; // accounts: how many keys its holder may have
};

// A change that can't be made, with why (an HTTP 400).
export class KeyChangeError extends Error {}

const MAX_AMOUNT = 1e15;

function amount(value: unknown, field: string, nullable: boolean): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_AMOUNT) {
    throw new KeyChangeError(`\`${field}\` must be a whole number, 0 or more${nullable ? ", or null for no limit" : ""}`);
  }
  return value;
}

// A bare date ("2026-11-25") means to the end of that day, UTC.
function expiry(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new KeyChangeError("`expiresAt` must be a date, like 2026-11-25, or null");
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T23:59:59.999Z`) : Date.parse(value);
  if (Number.isNaN(at)) throw new KeyChangeError("`expiresAt` must be a date, like 2026-11-25, or null");
  return new Date(at).toISOString();
}

// The changes in a request body, checked. Throws a KeyChangeError when
// something's wrong.
export function parseChanges(body: unknown, knownProviders: readonly string[]): KeyChanges {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new KeyChangeError("Send a JSON object");
  const b = body as Record<string, unknown>;
  const changes: KeyChanges = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string") throw new KeyChangeError("`name` must be a string");
    changes.name = b.name.trim().slice(0, 100) || "untitled";
  }
  if (b.label !== undefined && changes.name === undefined && typeof b.label === "string") {
    changes.name = b.label.trim().slice(0, 100) || "untitled"; // the older name for it
  }
  if (b.note !== undefined) {
    if (typeof b.note !== "string") throw new KeyChangeError("`note` must be a string");
    changes.note = b.note.trim().slice(0, 1000);
  }
  for (const field of ["disabled", "agentTools", "rotate", "activate"] as const) {
    const value = b[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new KeyChangeError(`\`${field}\` must be true or false`);
    changes[field] = value;
  }
  if (b.expiresAt !== undefined) changes.expiresAt = expiry(b.expiresAt);
  if (b.limits !== undefined) {
    if (!b.limits || typeof b.limits !== "object") throw new KeyChangeError("`limits` must be an object");
    const l = b.limits as Record<string, unknown>;
    const limits: Partial<KeyLimits> = {};
    if (l.period !== undefined) {
      if (!PERIODS.includes(l.period as Period)) throw new KeyChangeError("`limits.period` must be day, month or total");
      limits.period = l.period as Period;
    }
    for (const field of ["tokens", "requests", "perMinute"] as const) {
      if (l[field] !== undefined) limits[field] = amount(l[field], `limits.${field}`, true);
    }
    changes.limits = limits;
  }
  if (b.providers !== undefined) {
    if (b.providers === null) changes.providers = null;
    else if (Array.isArray(b.providers) && b.providers.every((p) => typeof p === "string")) {
      const unknown = b.providers.filter((p) => !knownProviders.includes(p));
      if (unknown.length) throw new KeyChangeError(`Unknown provider ${unknown.join(", ")}. Known: ${knownProviders.join(", ")}`);
      changes.providers = [...new Set(b.providers as string[])];
    } else throw new KeyChangeError("`providers` must be a list of provider ids, or null for all of them");
  }
  for (const field of ["addTokens", "addRequests", "extendDays", "maxKeys"] as const) {
    if (b[field] !== undefined) changes[field] = amount(b[field], field, false) ?? 0;
  }
  return changes;
}

function apply(a: Allowance & { note: string; name?: string }, changes: KeyChanges, now = Date.now()): void {
  if (changes.name !== undefined && "name" in a) a.name = changes.name;
  if (changes.note !== undefined) a.note = changes.note;
  if (changes.disabled !== undefined) a.disabled = changes.disabled;
  if (changes.expiresAt !== undefined) a.expiresAt = changes.expiresAt;
  if (changes.limits) a.limits = { ...a.limits, ...changes.limits };
  if (changes.providers !== undefined) a.providers = changes.providers;
  if (changes.agentTools !== undefined) a.agentTools = changes.agentTools;
  if (changes.addTokens) {
    if (a.limits.tokens === null) throw new KeyChangeError("There's no token limit to add to");
    a.limits.tokens += changes.addTokens;
  }
  if (changes.addRequests) {
    if (a.limits.requests === null) throw new KeyChangeError("There's no request limit to add to");
    a.limits.requests += changes.addRequests;
  }
  if (changes.extendDays) {
    if (!a.expiresAt) throw new KeyChangeError("It never expires, so there's nothing to extend");
    const from = Math.max(Date.parse(a.expiresAt), now);
    a.expiresAt = new Date(from + changes.extendDays * 86_400_000).toISOString();
  }
}

// A key the owner makes (with its own allowance), or, with `userId`, one an
// account's holder makes (with the account's).
export async function createKey(
  settings: KeyChanges,
  userId: string | null = null
): Promise<{ key: ApiToken; secret: string }> {
  const s = await ready();
  const secret = newSecret();
  const key = normalize({
    id: randomBytes(8).toString("hex"),
    hash: hashOf(secret),
    hint: hintOf(secret),
    createdAt: new Date().toISOString(),
    userId,
  });
  apply(key, { ...settings, addTokens: undefined, addRequests: undefined, extendDays: undefined });
  s.file.tokens.push(key);
  await saveNow(s);
  return { key, secret };
}

// Null when there's no key with that id.
export async function updateKey(id: string, changes: KeyChanges): Promise<{ key: ApiToken; secret?: string } | null> {
  const s = await ready();
  const key = s.file.tokens.find((t) => t.id === id);
  if (!key) return null;
  const draft = structuredClone(key);
  apply(draft, changes); // throws before anything changes
  let secret: string | undefined;
  if (changes.rotate) {
    secret = newSecret();
    draft.hash = hashOf(secret);
    draft.hint = hintOf(secret);
  }
  Object.assign(key, draft);
  await saveNow(s);
  return { key, secret };
}

export async function deleteKey(id: string): Promise<boolean> {
  const s = await ready();
  const before = s.file.tokens.length;
  s.file.tokens = s.file.tokens.filter((t) => t.id !== id);
  if (s.file.tokens.length === before) return false;
  s.recent.delete(id);
  await saveNow(s);
  return true;
}

// The account of a signed-in user, made (waiting to be activated) the first
// time they sign in, with the email address kept up to date.
export async function ensureAccount(user: { id: string; email: string }): Promise<Account> {
  const s = await ready();
  let account = accountIn(s, user.id);
  if (!account) {
    account = normalizeAccount({ userId: user.id, email: user.email, createdAt: new Date().toISOString() });
    s.file.accounts.push(account);
    await saveNow(s);
  } else if (account.email !== user.email) {
    account.email = user.email;
    await saveNow(s);
  }
  return account;
}

// The owner's changes to an account. Made first if the user hasn't signed in
// to their dashboard yet.
export async function updateAccount(user: { id: string; email: string }, changes: KeyChanges): Promise<Account> {
  const s = await ready();
  const account = await ensureAccount(user);
  const draft = structuredClone(account);
  apply(draft, { ...changes, name: undefined, rotate: undefined });
  if (changes.activate !== undefined) draft.activatedAt = changes.activate ? (draft.activatedAt ?? new Date().toISOString()) : null;
  if (changes.maxKeys !== undefined) draft.maxKeys = changes.maxKeys;
  Object.assign(account, draft);
  await saveNow(s);
  return account;
}

// For lib/redeem-codes.ts, which keeps its codes in this file: the file as
// it is, and a change to it, saved before it's answered. `change` must check
// everything before it changes anything: when it throws, nothing is saved.
export async function readTokenFile(): Promise<TokenFile> {
  return (await ready()).file;
}

export async function changeTokenFile<T>(change: (file: TokenFile) => T): Promise<T> {
  const s = await ready();
  const result = change(s.file);
  await saveNow(s);
  return result;
}

export async function accountKeys(userId: string): Promise<ApiToken[]> {
  return (await ready()).file.tokens.filter((t) => t.userId === userId);
}

export async function addAccountCredit(
  userId: string,
  amountUSD: number,
  orderId?: string | null,
  description?: string
): Promise<Account | null> {
  return changeTokenFile((file) => {
    const account = file.accounts.find((a) => a.userId === userId);
    if (!account) return null;
    const curr = account.creditBalance ?? account.balance ?? 0;
    const next = Math.max(0, Number((curr + amountUSD).toFixed(6)));
    const nextCents = Math.round(next * 100);
    account.balance = next;
    account.creditBalance = next;
    account.creditBalanceCents = nextCents;
    account.activatedAt ??= new Date().toISOString();

    const tx: CreditTransaction = {
      id: randomBytes(8).toString("hex"),
      userId,
      type: "deposit",
      amountCents: Math.round(amountUSD * 100),
      amountUSD,
      balanceAfterCents: nextCents,
      balanceAfterUSD: next,
      description: description || `Deposit: +$${amountUSD.toFixed(2)}`,
      orderId: orderId || null,
      createdAt: new Date().toISOString(),
    };
    account.transactions = Array.isArray(account.transactions) ? account.transactions : [];
    account.transactions.push(tx);

    return account;
  });
}

export async function addAccountCreditCents(
  userId: string,
  amountCents: number,
  orderId?: string | null,
  description?: string
): Promise<Account | null> {
  return addAccountCredit(userId, amountCents / 100, orderId, description);
}

export async function deductAccountCredit(
  userId: string,
  costUSD: number,
  description?: string
): Promise<{ previousBalance: number; newBalance: number; account: Account } | null> {
  return changeTokenFile((file) => {
    const account = file.accounts.find((a) => a.userId === userId);
    if (!account) return null;
    const curr = account.creditBalance ?? account.balance ?? 0;
    const next = Math.max(0, Number((curr - costUSD).toFixed(6)));
    const nextCents = Math.round(next * 100);
    account.balance = next;
    account.creditBalance = next;
    account.creditBalanceCents = nextCents;

    const tx: CreditTransaction = {
      id: randomBytes(8).toString("hex"),
      userId,
      type: "usage",
      amountCents: -Math.round(costUSD * 100),
      amountUSD: -costUSD,
      balanceAfterCents: nextCents,
      balanceAfterUSD: next,
      description: description || `Usage: -$${costUSD.toFixed(4)}`,
      createdAt: new Date().toISOString(),
    };
    account.transactions = Array.isArray(account.transactions) ? account.transactions : [];
    account.transactions.push(tx);

    return { previousBalance: curr, newBalance: next, account };
  });
}

export function getAccountCredit(account: Account): number {
  return account.creditBalance ?? account.balance ?? 0;
}

export function getAccountCreditCents(account: Account): number {
  return (
    account.creditBalanceCents ??
    Math.round((account.creditBalance ?? account.balance ?? 0) * 100)
  );
}

export async function accountTransactions(userId: string): Promise<CreditTransaction[]> {
  const s = await ready();
  const account = accountIn(s, userId);
  return (account?.transactions ?? []).slice(-100).reverse();
}
export async function deductCreditForUsage(
  userId: string,
  provider: string,
  modelName: string | undefined,
  inputTokens: number,
  outputTokens: number
): Promise<{ cost: UsageCost; previousBalance: number; newBalance: number } | null> {
  const cost = calculateUsageCost(provider, modelName, inputTokens, outputTokens);
  if (cost.totalCost <= 0) return null;
  const description = cost.rate.model + ": " + inputTokens.toLocaleString() + " prompt + " + outputTokens.toLocaleString() + " completion tokens ($" + cost.totalCost.toFixed(6) + ")";
  const result = await deductAccountCredit(userId, cost.totalCost, description);
  if (!result) return null;
  return {
    cost,
    previousBalance: result.previousBalance,
    newBalance: result.newBalance,
  };
}
