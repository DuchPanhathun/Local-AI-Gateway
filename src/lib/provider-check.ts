import { callProvider, isProviderId, keySetup, PROVIDER_IDS, providerHost, type ProviderId } from "./ai-providers";
import { ask, gatewayAddress, isLocalAgentProviderId, isWebChat, LOCAL_AGENT_PROVIDER_IDS, type LocalAgentProviderId } from "./local-agent";
import { getPausedProviders } from "./provider-state";
import { RateLimitedError } from "./rate-limits";

// Can this provider answer a chat? A key, or a CLI that is installed and signed
// in, doesn't say: keys get revoked, plans run out, CLIs break halfway. So each
// provider is tested with a real, tiny chat, and one that fails is held (see
// provider-setup.ts) until a later test passes.
//
// When it runs: once, when the server starts, for the cloud APIs and the CLIs
// (a few tokens each, or a tiny run on the owner's plan). Not on a timer after
// that. The websites (ChatGPT, Grok, MiMo) aren't tested at start either: they
// share one Chrome window, and MiMo saves every chat to its history. They're
// tested when the owner presses Test or Resume. A provider the owner paused,
// or that isn't set up, is not tested.
// After the start: a real request that fails because of the provider asks for
// a test (so one that breaks later is held too), and a provider that failed at
// start is tried again after 30 s, 1 minute and 2 minutes, in case it was only
// the gateway still starting. Then it waits for the owner to press Test.
// Test chats are not recorded as traffic: not in the usage ledger, not charged.
// Only an answer is a verdict. If the gateway (or the cloud API) can't be
// reached at all, the test says nothing about the provider: it isn't held, and
// the console says what couldn't be reached. And PROVIDER_CHECK_SKIP=a,b names
// providers that are never tested by themselves or held by a test: one used
// with a model the test chat doesn't use, say. Pressing Test still tests them.

export type CheckStatus = "ok" | "failing" | "unverified";

export type ProviderCheck = {
  // "unverified" with a `reason`: tried, and couldn't be reached to ask.
  status: CheckStatus;
  checkedAt: number | null; // when it last passed or failed
  source: "test" | "traffic" | null; // what showed it works: a test chat, or a real request
  reason: string | null; // why the last test failed, or couldn't be run
  limited: boolean; // it answered, but said it was busy or at a usage limit
  testing: boolean;
};

type Entry = ProviderCheck & {
  failures: number; // tests failed in a row
  nextAt: number; // when a provider that failed is tried again, if it still is
  lastTrigger: number; // when a failed request last asked for a test
  running: Promise<ProviderCheck> | null;
};

type Checks = {
  entries: Map<string, Entry>;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  // Whether a provider isn't set up (no key, no CLI, signed out): nothing to test.
  blocked: ((provider: string) => Promise<boolean>) | null;
};

// One of these per process, even if the bundler hands each route its own copy
// of this module.
const globalRef = globalThis as typeof globalThis & { __aiThunChecks?: Checks };

const state = () => (globalRef.__aiThunChecks ??= { entries: new Map(), timer: null, ticking: false, blocked: null });

const ALL: string[] = [...PROVIDER_IDS, ...LOCAL_AGENT_PROVIDER_IDS];
const PROMPT = "Reply with exactly: ok";
const TICK_MS = 5_000;
const MAX_AT_ONCE = 3;
const TRIGGER_GAP_MS = 30_000;
// Claude Code and Codex can run with none of their tools, as a plain model.
const NO_TOOLS = new Set<string>(["claude", "codex"]);

function entry(provider: string): Entry {
  const { entries } = state();
  let e = entries.get(provider);
  if (!e) {
    e = {
      status: "unverified", checkedAt: null, source: null, reason: null, limited: false, testing: false,
      failures: 0, nextAt: 0, lastTrigger: 0, running: null,
    }; // fmt: skip
    entries.set(provider, e);
  }
  return e;
}

function view(e: Entry): ProviderCheck {
  const { status, checkedAt, source, reason, limited, testing } = e;
  return { status, checkedAt, source, reason, limited, testing };
}

export const checkOf = (provider: string): ProviderCheck => view(entry(provider));

export function getChecks(): Record<string, ProviderCheck> {
  return Object.fromEntries(ALL.map((p) => [p, checkOf(p)]));
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

function number(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const isWebsite = (provider: string) => isLocalAgentProviderId(provider) && isWebChat(provider);

// Providers the owner keeps out of the automatic tests and the holds.
export function isCheckSkipped(provider: string): boolean {
  return (process.env.PROVIDER_CHECK_SKIP ?? "").split(",").some((name) => name.trim() === provider);
}

// A failed test is tried again this many times by itself: after 30 s, 1 and 2 minutes.
const AUTO_RETRIES = 3;

function retryMs(failures: number): number {
  return number("PROVIDER_CHECK_RETRY_SECONDS", 30) * 1000 * 2 ** Math.max(0, failures - 1);
}

// Off in development (it would spend the developer's plans), on in production.
function automatic(): boolean {
  const setting = process.env.PROVIDER_CHECKS;
  return setting ? setting !== "off" : process.env.NODE_ENV === "production";
}

// ---------------------------------------------------------------------------
// The test chat
// ---------------------------------------------------------------------------

// `unreachable`: nothing answered, so the test says nothing about the provider.
type Verdict = { ok: true; limited: boolean } | { ok: false; reason: string; unreachable?: true };

const clean = (reason: string) => reason.replace(/\s+/g, " ").trim().slice(0, 240) || "no answer";
const pass = (limited = false): Verdict => ({ ok: true, limited });
const fail = (reason: string): Verdict => ({ ok: false, reason: clean(reason) });
const unreachable = (reason: string): Verdict => ({ ok: false, reason: clean(reason), unreachable: true });

const NETWORK_CODES: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ENOTFOUND: "address not found",
  EAI_AGAIN: "address not found",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  ETIMEDOUT: "timed out",
  UND_ERR_CONNECT_TIMEOUT: "timed out",
};

// What a fetch that never got an answer says ("fetch failed", with the cause
// inside), or null if the error is something else.
function noConnection(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && code in NETWORK_CODES) return NETWORK_CODES[code];
  return err.message === "fetch failed" ? "no connection" : null;
}

// "HTTP 401: Invalid API Key", from whatever shape the error body has.
function why(status: number, data: unknown): string {
  const body = data as { error?: unknown; detail?: unknown; message?: unknown } | null;
  const error = body?.error;
  const text =
    typeof error === "string" ? error
    : typeof (error as { message?: unknown } | undefined)?.message === "string" ? (error as { message: string }).message
    : typeof body?.detail === "string" ? body.detail
    : typeof body?.message === "string" ? body.message
    : "";
  return `HTTP ${status}${text ? `: ${text}` : ""}`;
}

// The key rotation hands each call the next key, so a bad key among several
// doesn't fail the provider: the next one is tried when a key is refused,
// unpaid or forbidden (each can be its own account's trouble), until one
// answers or none is left. A provider at its rate limit still answers.
async function probeCloud(provider: ProviderId): Promise<Verdict> {
  const body = {
    messages: [{ role: "user", content: PROMPT }],
    max_tokens: 16,
    ...(provider === "sea-lion" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
  let reason = "";
  for (let i = 0; i < Math.max(1, keySetup(provider).count); i++) {
    try {
      const { status, data } = await callProvider(provider, body, undefined, { silent: true });
      if (status >= 200 && status < 300) return pass();
      reason = why(status, data);
      if (status !== 401 && status !== 402 && status !== 403) break; // not about the key: another won't differ
    } catch (err) {
      if (err instanceof RateLimitedError) return pass(true);
      const why = noConnection(err);
      if (why) return unreachable(`Couldn't reach ${providerHost(provider)} (${why}).`);
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  return fail(reason);
}

async function probeLocal(provider: LocalAgentProviderId): Promise<Verdict> {
  const waitMs = isWebChat(provider) ? 180_000 : 120_000; // Grok reasons for up to 35 s
  try {
    const { status, data } = await ask(
      { provider, prompt: PROMPT, ...(NO_TOOLS.has(provider) ? { no_tools: true } : {}) },
      AbortSignal.timeout(waitMs),
    );
    if (status === 429) return pass(true); // busy, or at its plan's usage limit: it does answer
    if (status < 200 || status >= 300) return fail(why(status, data));
    const result = (data as { result?: unknown } | null)?.result;
    return typeof result === "string" && result.trim() ? pass() : fail("It answered with nothing.");
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return fail(`No answer after ${waitMs / 1000} s.`);
    }
    const why = noConnection(err);
    if (why) return unreachable(`${gatewayAddress(provider)} isn't answering (${why}). Is it running?`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function probe(provider: string): Promise<Verdict> {
  const attempt = isProviderId(provider)
    ? probeCloud(provider)
    : isLocalAgentProviderId(provider)
      ? probeLocal(provider)
      : Promise.resolve(fail("Not a provider."));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fail("No answer after 200 s.")), 200_000);
    attempt.then(resolve, (err) => resolve(fail(err instanceof Error ? err.message : String(err)))).finally(() => clearTimeout(timer));
  });
}

// Tests the provider now (or joins the test already running). A first failure is
// confirmed once before it holds the provider, so a hiccup doesn't.
export function runCheck(provider: string): Promise<ProviderCheck> {
  const e = entry(provider);
  if (e.running) return e.running;
  e.testing = true;
  const run = (async () => {
    let verdict = await probe(provider);
    if (!verdict.ok && !verdict.unreachable && e.status !== "failing") {
      await new Promise((resolve) => setTimeout(resolve, number("PROVIDER_CHECK_CONFIRM_SECONDS", 2) * 1000));
      verdict = await probe(provider);
    }
    const now = Date.now();
    if (!verdict.ok && verdict.unreachable) {
      // No answer says nothing about the provider: don't hold it. One that was
      // held is let go, as nobody can say it still fails; one that passed stays.
      if (e.status !== "ok") {
        e.failures += 1;
        Object.assign(e, {
          status: "unverified", checkedAt: now, source: null, reason: verdict.reason, limited: false,
          nextAt: now + retryMs(e.failures),
        }); // fmt: skip
      }
    } else if (verdict.ok) {
      Object.assign(e, {
        status: "ok", checkedAt: now, source: "test", reason: null, limited: verdict.limited, failures: 0,
      }); // fmt: skip
    } else {
      e.failures += 1;
      Object.assign(e, {
        status: "failing", checkedAt: now, source: null, reason: verdict.reason, limited: false,
        nextAt: now + retryMs(e.failures),
      }); // fmt: skip
    }
    return view(e);
  })().finally(() => {
    e.testing = false;
    e.running = null;
  });
  e.running = run;
  return run;
}

// ---------------------------------------------------------------------------
// What real requests say
// ---------------------------------------------------------------------------

// A real chat that worked is as good as a test (and a website, never tested by
// itself, is shown to work this way).
export function noteWorking(provider: string): void {
  const e = entry(provider);
  if (e.status === "failing") return; // held: only a test lifts that
  Object.assign(e, { status: "ok", checkedAt: Date.now(), source: "traffic", reason: null, limited: false, failures: 0 }); // fmt: skip
}

// A real chat that failed because of the provider (not a bad request, not a
// limit) asks for a test, which decides whether the provider is held.
function requestCheck(provider: string): void {
  const e = entry(provider);
  const now = Date.now();
  if (!automatic() || isCheckSkipped(provider) || e.running || e.status === "failing") return;
  if (now - e.lastTrigger < TRIGGER_GAP_MS) return;
  e.lastTrigger = now;
  void (async () => {
    if ((await getPausedProviders()).includes(provider) || (await state().blocked?.(provider))) return;
    await runCheck(provider);
  })().catch(() => {});
}

// What a chat route got back from the provider: a 2xx, a refused key (401) or a
// failure on its side (5xx) say something about it; other 4xx are the caller's.
export function noteChatOutcome(provider: string, status: number): void {
  if (status >= 200 && status < 300) noteWorking(provider);
  else if (status === 401 || status >= 500) requestCheck(provider);
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const s = state();
  if (s.ticking) return;
  s.ticking = true;
  try {
    const manual = new Set(await getPausedProviders());
    let running = [...s.entries.values()].filter((e) => e.running).length;
    for (const provider of ALL) {
      if (running >= MAX_AT_ONCE) break;
      const e = entry(provider);
      if (e.running || isCheckSkipped(provider) || manual.has(provider) || (await s.blocked?.(provider))) continue;
      // Tried without a pass (failed, or couldn't be reached): again after a wait, a few times.
      // Never tried: the test at start, except a website.
      const due =
        e.status === "ok"
          ? false
          : e.checkedAt !== null
            ? e.failures <= AUTO_RETRIES && Date.now() >= e.nextAt
            : !isWebsite(provider);
      if (!due) continue;
      running++;
      void runCheck(provider);
    }
  } catch (err) {
    console.error("Provider checks:", err);
  } finally {
    s.ticking = false;
  }
}

// `blocked`: whether a provider isn't set up. Starts the timer (once, and only
// where the checks are on); the callback is refreshed on every call.
export function startChecks(blocked: (provider: string) => Promise<boolean>): void {
  const s = state();
  s.blocked = blocked;
  if (s.timer || !automatic()) return;
  s.timer = setInterval(() => void tick(), TICK_MS);
  s.timer.unref?.();
  setTimeout(() => void tick(), 2_000).unref?.();
}
