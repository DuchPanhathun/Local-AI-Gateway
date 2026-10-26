import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { statePath, writeJsonAtomic, writeJsonAtomicSync } from "./state-files";

// Access tokens: API keys for other people and apps, each with its own limits,
// expiry, providers and usage, managed from the console's API keys page. Kept
// in the state folder (tokens.json), like the usage ledger, so restarts and
// deploys keep them. Only a SHA-256 hash of each key is stored: the key itself
// is shown once, when it's made (or made again).
//
// Usage is counted per key, UTC day, provider and model. Held in memory and
// saved a second after each change and again on shutdown; changes the owner
// makes are saved before they're answered.

const TOKENS_FILE = statePath("tokens.json");
const SAVE_DELAY_MS = 1_000;
const KEEP_DAYS = 400; // per-day usage; the all-time totals are kept for good
const KEY_PREFIX = "sk-ai-thun-";
const IMPORT_RETRY_MS = 60_000;

export type Period = "day" | "month" | "total";
export const PERIODS: readonly Period[] = ["day", "month", "total"];

export type KeyLimits = {
  // What `tokens` and `requests` count over: the UTC day, the UTC month, or
  // the key's whole life (a prepaid amount, topped up by raising it).
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

export type ApiToken = {
  id: string;
  name: string;
  note: string; // the owner's own: never shown to the key's holder
  hash: string; // SHA-256 of the key, hex
  hint: string; // "sk-ai-thun-ab12…cd34"
  createdAt: string;
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

type TokenFile = {
  version: 1;
  // Tokens from when ai-thun ran on Vercel were kept in Edge Config; they're
  // brought over once.
  importedFromEdgeConfig: boolean;
  tokens: ApiToken[];
};

type Store = {
  file: TokenFile;
  changes: number; // bumped on every change
  savedChanges: number; // `changes` as of the last completed save
  timer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void>;
  importing: Promise<void> | null;
  importRetryAt: number;
  recent: Map<string, number[]>; // request times in the last minute, by key id
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

// A key read from the file, with any field an older file lacks filled in.
function normalize(t: Partial<ApiToken>): ApiToken {
  return {
    id: String(t.id),
    name: t.name ?? "untitled",
    note: t.note ?? "",
    hash: String(t.hash),
    hint: t.hint ?? "",
    createdAt: t.createdAt ?? new Date(0).toISOString(),
    disabled: Boolean(t.disabled),
    expiresAt: t.expiresAt ?? null,
    limits: { ...DEFAULT_LIMITS, ...t.limits },
    providers: Array.isArray(t.providers) ? t.providers : null,
    agentTools: Boolean(t.agentTools),
    lastUsedAt: t.lastUsedAt ?? null,
    total: { ...emptyCounts(), ...t.total },
    days: t.days ?? {},
  };
}

function load(): TokenFile {
  let raw: string;
  try {
    raw = readFileSync(TOKENS_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Can't read ${TOKENS_FILE}:`, err);
    }
    return { version: 1, importedFromEdgeConfig: false, tokens: [] };
  }
  try {
    const data = JSON.parse(raw) as Partial<TokenFile>;
    if (!Array.isArray(data.tokens)) throw new Error("it has no `tokens`");
    return {
      version: 1,
      importedFromEdgeConfig: Boolean(data.importedFromEdgeConfig),
      tokens: data.tokens.map(normalize),
    };
  } catch (err) {
    // Set the unreadable file aside rather than overwrite it on the next save.
    const aside = `${TOKENS_FILE}.unreadable-${Date.now()}`;
    try {
      renameSync(TOKENS_FILE, aside);
    } catch {}
    console.error(`${TOKENS_FILE} isn't a token list; moved it to ${aside}:`, err);
    return { version: 1, importedFromEdgeConfig: false, tokens: [] };
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

// What the key has used in its current period.
export function usedInPeriod(key: ApiToken, now = new Date()): Counts {
  if (key.limits.period === "total") return { ...key.total };
  const today = utcDay(now);
  const prefix = key.limits.period === "day" ? today : today.slice(0, 7);
  const used = emptyCounts();
  for (const [day, usage] of Object.entries(key.days)) {
    if (day.startsWith(prefix)) addCounts(used, usage);
  }
  return used;
}

// Requests that count against the limit: failed ones don't.
function counted(c: Counts): number {
  return c.requests - c.errors;
}

export type KeyStatus = "active" | "disabled" | "expired" | "limited";

export type KeyBlock = { status: 403 | 429; error: string; retryAfter?: number };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function whenUTC(iso: string): string {
  return `${dateFormat.format(new Date(iso))} UTC`;
}

// Why the key can't be used right now, or null when it can.
export function blockOf(key: ApiToken, now = Date.now()): KeyBlock | null {
  if (key.disabled) return { status: 403, error: "This API key is turned off." };
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) {
    return { status: 403, error: `This API key expired on ${whenUTC(key.expiresAt)}.` };
  }
  const { period, tokens, requests } = key.limits;
  const used = usedInPeriod(key, new Date(now));
  const over =
    tokens !== null && used.tokens >= tokens
      ? `${tokens.toLocaleString("en")} tokens`
      : requests !== null && counted(used) >= requests
        ? `${requests.toLocaleString("en")} requests`
        : null;
  if (!over) return null;
  const reset = resetsAt(period, new Date(now));
  if (!reset) return { status: 429, error: `This API key has used all of its ${over}.` };
  return {
    status: 429,
    error: `This API key has used its ${over} for ${period === "day" ? "today" : "this month"}. They come back on ${whenUTC(reset)}.`,
    retryAfter: Math.ceil((Date.parse(reset) - now) / 1000),
  };
}

export function statusOf(key: ApiToken, now = Date.now()): KeyStatus {
  if (key.disabled) return "disabled";
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return "expired";
  return blockOf(key, now) ? "limited" : "active";
}

// Lets one request through, or says why not. Counts it toward the
// per-minute limit (held in memory: a restart forgives).
export function admit(key: ApiToken, now = Date.now()): KeyBlock | null {
  const blocked = blockOf(key, now);
  if (blocked) return blocked;
  const s = store();
  const times = (s.recent.get(key.id) ?? []).filter((t) => t > now - 60_000);
  const perMinute = key.limits.perMinute;
  if (perMinute !== null && times.length >= perMinute) {
    s.recent.set(key.id, times);
    return {
      status: 429,
      error: `This API key is limited to ${perMinute.toLocaleString("en")} requests a minute.`,
      retryAfter: Math.max(1, Math.ceil((times[0] + 60_000 - now) / 1000)),
    };
  }
  if (perMinute !== null) s.recent.set(key.id, [...times, now]);
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

// One request made with key `id`. `tokens`: what the provider reported, or
// null when it didn't say, and they're estimated from `textChars` (the
// prompt and answer) instead.
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
  const today = utcDay(now);
  if (!key.days[today]) {
    const cutoff = utcDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
    for (const day of Object.keys(key.days)) if (day < cutoff) delete key.days[day];
  }
  const day = (key.days[today] ??= { ...emptyCounts(), providers: {} });
  const byModel = (day.providers[provider] ??= {});
  addCounts((byModel[model] ??= emptyCounts()), used);
  addCounts(day, used);
  addCounts(key.total, used);
  key.lastUsedAt = now.toISOString();

  s.changes += 1;
  scheduleSave(s);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type KeySummary = {
  id: string;
  name: string;
  note: string;
  hint: string;
  createdAt: string;
  status: KeyStatus;
  disabled: boolean;
  expiresAt: string | null;
  limits: KeyLimits;
  providers: string[] | null;
  agentTools: boolean;
  lastUsedAt: string | null;
  // The current period: today, this month (UTC), or the key's whole life.
  used: Counts;
  remaining: { tokens: number | null; requests: number | null }; // null: no limit
  resetsAt: string | null;
  total: Counts;
};

export function summarize(key: ApiToken, now = new Date()): KeySummary {
  const used = usedInPeriod(key, now);
  const { tokens, requests } = key.limits;
  return {
    id: key.id,
    name: key.name,
    note: key.note,
    hint: key.hint,
    createdAt: key.createdAt,
    status: statusOf(key, now.getTime()),
    disabled: key.disabled,
    expiresAt: key.expiresAt,
    limits: { ...key.limits },
    providers: key.providers ? [...key.providers] : null,
    agentTools: key.agentTools,
    lastUsedAt: key.lastUsedAt,
    used,
    remaining: {
      tokens: tokens === null ? null : Math.max(0, tokens - used.tokens),
      requests: requests === null ? null : Math.max(0, requests - counted(used)),
    },
    resetsAt: resetsAt(key.limits.period, now),
    total: { ...key.total },
  };
}

// What the key's holder sees (GET /api/me): no id, and not the owner's note.
export function holderView(key: ApiToken, now = new Date()) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, note: _note, ...rest } = summarize(key, now);
  return rest;
}

export type KeyMonth = {
  month: string;
  totals: Counts;
  days: { day: string; requests: number; tokens: number }[]; // every day of the month
  models: (Counts & { provider: string; model: string })[]; // most tokens first
};

// `month` is "2026-10" (UTC).
export function keyMonth(key: ApiToken, month: string): KeyMonth {
  const [year, mon] = month.split("-").map(Number);
  const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const totals = emptyCounts();
  const models = new Map<string, Counts & { provider: string; model: string }>();
  const days = Array.from({ length }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, "0")}`;
    const usage = key.days[day];
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

export async function listKeys(): Promise<ApiToken[]> {
  return (await ready()).file.tokens;
}

export async function getKey(id: string): Promise<ApiToken | null> {
  return (await ready()).file.tokens.find((t) => t.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// The owner's changes
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
};

// A change the owner asked for that can't be made, with why (an HTTP 400).
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
  for (const field of ["disabled", "agentTools", "rotate"] as const) {
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
  for (const field of ["addTokens", "addRequests", "extendDays"] as const) {
    if (b[field] !== undefined) changes[field] = amount(b[field], field, false) ?? 0;
  }
  return changes;
}

function apply(key: ApiToken, changes: KeyChanges, now = Date.now()): void {
  if (changes.name !== undefined) key.name = changes.name;
  if (changes.note !== undefined) key.note = changes.note;
  if (changes.disabled !== undefined) key.disabled = changes.disabled;
  if (changes.expiresAt !== undefined) key.expiresAt = changes.expiresAt;
  if (changes.limits) key.limits = { ...key.limits, ...changes.limits };
  if (changes.providers !== undefined) key.providers = changes.providers;
  if (changes.agentTools !== undefined) key.agentTools = changes.agentTools;
  if (changes.addTokens) {
    if (key.limits.tokens === null) throw new KeyChangeError("This key has no token limit to add to");
    key.limits.tokens += changes.addTokens;
  }
  if (changes.addRequests) {
    if (key.limits.requests === null) throw new KeyChangeError("This key has no request limit to add to");
    key.limits.requests += changes.addRequests;
  }
  if (changes.extendDays) {
    if (!key.expiresAt) throw new KeyChangeError("This key never expires, so there's nothing to extend");
    const from = Math.max(Date.parse(key.expiresAt), now);
    key.expiresAt = new Date(from + changes.extendDays * 86_400_000).toISOString();
  }
}

export async function createKey(settings: KeyChanges): Promise<{ key: ApiToken; secret: string }> {
  const s = await ready();
  const secret = newSecret();
  const key = normalize({
    id: randomBytes(8).toString("hex"),
    hash: hashOf(secret),
    hint: hintOf(secret),
    createdAt: new Date().toISOString(),
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
