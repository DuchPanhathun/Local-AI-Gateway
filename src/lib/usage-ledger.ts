import { readFileSync, renameSync } from "node:fs";
import { estimateTokens, recordKeyUsage } from "./api-tokens";
import { statePath, writeJsonAtomic, writeJsonAtomicSync } from "./state-files";

// Usage that outlives restarts: requests and tokens per UTC day, provider and
// model (and, for cloud APIs, per key) for every call through the gateway.
// The Dashboard's daily and monthly numbers, Analytics' daily totals and
// Groq's per-key daily token cap all read from here. Held in memory and saved
// to the state folder a second after each change and again on shutdown, so a
// crash loses at most that second.

const LEDGER_FILE = statePath("usage.json");
const SAVE_DELAY_MS = 1_000;
const KEEP_DAYS = 400; // a little over 13 months

export type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type UsageOutcome = {
  // "stopped": the caller hung up first. It counts as a request, not an error.
  status: "ok" | "error" | "stopped";
  usage?: TokenUsage | null;
  durationMs?: number;
  keyName?: string; // cloud APIs: the env var holding the key used, never the key
  caller?: string; // the access token's id, when one made the request
  // The prompt's and answer's length, for estimating the caller's tokens when
  // the provider doesn't report them.
  textChars?: number;
  // The same lengths apart, for a run that reported no tokens (a web chat,
  // Codex, Gemini): when it gave a text answer, the ledger keeps an estimate
  // of its tokens, beside the reported ones and marked as an estimate.
  promptChars?: number;
  answerChars?: number;
};

type Counts = {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensReported: number; // requests that said how many tokens they used
  // Requests that said nothing but answered in text, and their tokens estimated
  // from the text's length. Never added to the reported counts above.
  estimatedRequests: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  durationMs: number; // summed over finished requests that were timed
  timed: number;
  lastUsed: number; // epoch ms
};

type ModelEntry = Counts & {
  keys?: Record<string, { requests: number; tokens: number }>;
};

// days["2026-10-15"][provider][model]
type Ledger = {
  version: 1;
  days: Record<string, Record<string, Record<string, ModelEntry>>>;
};

type Store = {
  ledger: Ledger;
  changes: number; // bumped on every record
  savedChanges: number; // `changes` as of the last completed save
  timer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void>;
};

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyCounts(): Counts {
  return {
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    tokensReported: 0,
    estimatedRequests: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    durationMs: 0,
    timed: 0,
    lastUsed: 0,
  };
}

function prune(ledger: Ledger): Ledger {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const day of Object.keys(ledger.days)) {
    if (day < cutoff) delete ledger.days[day];
  }
  return ledger;
}

function load(): Ledger {
  let raw: string;
  try {
    raw = readFileSync(LEDGER_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Can't read ${LEDGER_FILE}; starting a new usage ledger:`, err);
    }
    return { version: 1, days: {} };
  }
  try {
    const days = (JSON.parse(raw) as Partial<Ledger>).days;
    if (!days || typeof days !== "object") throw new Error("it has no `days`");
    return prune({ version: 1, days });
  } catch (err) {
    // Set the unreadable file aside rather than overwrite it on the next save.
    const aside = `${LEDGER_FILE}.unreadable-${Date.now()}`;
    try {
      renameSync(LEDGER_FILE, aside);
    } catch {}
    console.error(`${LEDGER_FILE} isn't a usage ledger; moved it to ${aside}:`, err);
    return { version: 1, days: {} };
  }
}

// One store per process, even if the bundler hands several routes their own
// copy of this module.
const globalRef = globalThis as typeof globalThis & { __aiThunUsageStore?: Store };

function store(): Store {
  if (!globalRef.__aiThunUsageStore) {
    globalRef.__aiThunUsageStore = {
      ledger: load(),
      changes: 0,
      savedChanges: 0,
      timer: null,
      saving: Promise.resolve(),
    };
    // `next start` leaves through process.exit() on SIGTERM/SIGINT, which runs
    // this synchronously, so a restart keeps the last second's requests too.
    process.once("exit", saveBeforeExit);
  }
  return globalRef.__aiThunUsageStore;
}

async function save(s: Store): Promise<void> {
  const upTo = s.changes;
  if (upTo === s.savedChanges) return;
  try {
    await writeJsonAtomic(LEDGER_FILE, s.ledger);
    s.savedChanges = Math.max(s.savedChanges, upTo);
  } catch (err) {
    console.error("Couldn't save the usage ledger (will retry on the next request):", err);
  }
}

function scheduleSave(s: Store): void {
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    s.saving = s.saving.then(() => save(s));
  }, SAVE_DELAY_MS);
  (s.timer as { unref?: () => void }).unref?.();
}

function saveBeforeExit(): void {
  const s = globalRef.__aiThunUsageStore;
  if (!s || s.changes === s.savedChanges) return;
  try {
    writeJsonAtomicSync(LEDGER_FILE, s.ledger);
  } catch (err) {
    console.error("Couldn't save the usage ledger on exit:", err);
  }
}

function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function tokensOf(usage: TokenUsage | null | undefined) {
  if (!usage) return null;
  const prompt = count(usage.prompt_tokens);
  const completion = count(usage.completion_tokens);
  const total = usage.total_tokens === undefined ? prompt + completion : count(usage.total_tokens);
  return { prompt, completion, total };
}

export function recordUsageEvent(provider: string, model: string, outcome: UsageOutcome): void {
  const s = store();
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (!s.ledger.days[day]) prune(s.ledger);

  const byModel = ((s.ledger.days[day] ??= {})[provider] ??= {});
  // Spread over the defaults, so an entry from an older file gains new fields.
  const entry: ModelEntry = (byModel[model] = { ...emptyCounts(), ...byModel[model] });

  entry.requests += 1;
  entry.lastUsed = now;
  if (outcome.status === "error") entry.errors += 1;
  const tokens = tokensOf(outcome.usage);
  if (tokens) {
    entry.promptTokens += tokens.prompt;
    entry.completionTokens += tokens.completion;
    entry.totalTokens += tokens.total;
    entry.tokensReported += 1;
  } else if (outcome.status === "ok" && outcome.answerChars) {
    entry.estimatedRequests += 1;
    entry.estimatedPromptTokens += estimateTokens(outcome.promptChars ?? 0);
    entry.estimatedCompletionTokens += estimateTokens(outcome.answerChars);
  }
  if (outcome.status === "ok" && typeof outcome.durationMs === "number") {
    entry.durationMs += count(outcome.durationMs);
    entry.timed += 1;
  }
  if (outcome.keyName) {
    const key = ((entry.keys ??= {})[outcome.keyName] ??= { requests: 0, tokens: 0 });
    key.requests += 1;
    key.tokens += tokens?.total ?? 0;
  }

  if (outcome.caller) {
    recordKeyUsage(outcome.caller, provider, model, {
      failed: outcome.status === "error",
      tokens: tokens ? tokens.total : null,
      textChars: outcome.textChars,
    });
  }

  s.changes += 1;
  scheduleSave(s);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type UsageTotals = {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // What was estimated from text length for runs that reported none (web
  // chats, Codex, Gemini), on top of the reported counts above.
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTokens: number;
};

export type ModelUsage = UsageTotals & {
  provider: string;
  model: string;
  // False when none of its requests reported tokens (Codex, Gemini, Whisper):
  // its reported counts then mean "unknown", not "none" (see the estimated ones).
  tokensReported: boolean;
  avgDurationMs: number | null;
  timed: number;
  lastUsedAt: string | null;
};

function totalsOf(c: Counts): UsageTotals {
  return {
    requests: c.requests,
    errors: c.errors,
    promptTokens: c.promptTokens,
    completionTokens: c.completionTokens,
    totalTokens: c.totalTokens,
    estimatedPromptTokens: c.estimatedPromptTokens,
    estimatedCompletionTokens: c.estimatedCompletionTokens,
    estimatedTokens: c.estimatedPromptTokens + c.estimatedCompletionTokens,
  };
}

// Every provider and model used on any of `days`, added up across them.
function modelUsage(days: string[]): ModelUsage[] {
  const { ledger } = store();
  const merged = new Map<string, { provider: string; model: string; counts: Counts }>();
  for (const day of days) {
    for (const [provider, models] of Object.entries(ledger.days[day] ?? {})) {
      for (const [model, e] of Object.entries(models)) {
        const id = JSON.stringify([provider, model]);
        let m = merged.get(id);
        if (!m) merged.set(id, (m = { provider, model, counts: emptyCounts() }));
        const c = m.counts;
        c.requests += e.requests ?? 0;
        c.errors += e.errors ?? 0;
        c.promptTokens += e.promptTokens ?? 0;
        c.completionTokens += e.completionTokens ?? 0;
        c.totalTokens += e.totalTokens ?? 0;
        c.tokensReported += e.tokensReported ?? 0;
        c.estimatedPromptTokens += e.estimatedPromptTokens ?? 0;
        c.estimatedCompletionTokens += e.estimatedCompletionTokens ?? 0;
        c.durationMs += e.durationMs ?? 0;
        c.timed += e.timed ?? 0;
        c.lastUsed = Math.max(c.lastUsed, e.lastUsed ?? 0);
      }
    }
  }
  return [...merged.values()]
    .map(({ provider, model, counts: c }) => ({
      provider,
      model,
      ...totalsOf(c),
      tokensReported: c.tokensReported > 0,
      avgDurationMs: c.timed ? Math.round(c.durationMs / c.timed) : null,
      timed: c.timed,
      lastUsedAt: c.lastUsed ? new Date(c.lastUsed).toISOString() : null,
    }))
    .sort(
      (a, b) =>
        b.totalTokens + b.estimatedTokens - (a.totalTokens + a.estimatedTokens) ||
        b.requests - a.requests ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model)
    );
}

export function getDayUsage(day: string): ModelUsage[] {
  return modelUsage([day]);
}

// Requests and tokens per key and model for one cloud provider on `day`:
// keyName → model → counts.
export function getKeyDayUsage(
  provider: string,
  day: string
): Map<string, Map<string, { requests: number; tokens: number }>> {
  const result = new Map<string, Map<string, { requests: number; tokens: number }>>();
  for (const [model, e] of Object.entries(store().ledger.days[day]?.[provider] ?? {})) {
    for (const [keyName, k] of Object.entries(e.keys ?? {})) {
      let models = result.get(keyName);
      if (!models) result.set(keyName, (models = new Map()));
      models.set(model, { requests: k.requests ?? 0, tokens: k.tokens ?? 0 });
    }
  }
  return result;
}

export function getKeyDayTokens(provider: string, model: string, keyName: string, day: string): number {
  return store().ledger.days[day]?.[provider]?.[model]?.keys?.[keyName]?.tokens ?? 0;
}

export type MonthUsage = {
  month: string;
  totals: UsageTotals;
  models: ModelUsage[];
  days: { day: string; requests: number; totalTokens: number; estimatedTokens: number }[]; // every day of the month
};

// `month` is "2026-10" (UTC).
export function getMonthUsage(month: string): MonthUsage {
  const [year, mon] = month.split("-").map(Number);
  const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const dayList = Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const models = modelUsage(dayList);

  const totals: UsageTotals = {
    requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    estimatedPromptTokens: 0, estimatedCompletionTokens: 0, estimatedTokens: 0,
  }; // fmt: skip
  for (const m of models) {
    totals.requests += m.requests;
    totals.errors += m.errors;
    totals.promptTokens += m.promptTokens;
    totals.completionTokens += m.completionTokens;
    totals.totalTokens += m.totalTokens;
    totals.estimatedPromptTokens += m.estimatedPromptTokens;
    totals.estimatedCompletionTokens += m.estimatedCompletionTokens;
    totals.estimatedTokens += m.estimatedTokens;
  }

  const { ledger } = store();
  const days = dayList.map((day) => {
    let requests = 0;
    let totalTokens = 0;
    let estimatedTokens = 0;
    for (const models of Object.values(ledger.days[day] ?? {})) {
      for (const e of Object.values(models)) {
        requests += e.requests ?? 0;
        totalTokens += e.totalTokens ?? 0;
        estimatedTokens += (e.estimatedPromptTokens ?? 0) + (e.estimatedCompletionTokens ?? 0);
      }
    }
    return { day, requests, totalTokens, estimatedTokens };
  });

  return { month, totals, models, days };
}

// Months with any usage, plus the current one, newest first.
export function getUsageMonths(): string[] {
  const months = new Set([todayUTC().slice(0, 7)]);
  for (const day of Object.keys(store().ledger.days)) months.add(day.slice(0, 7));
  return [...months].sort().reverse();
}
