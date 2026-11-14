import { isProviderId, keySetup, PROVIDER_IDS } from "./ai-providers";
import { auth, health, isLocalAgentProviderId, isWebChat, LOCAL_AGENT_PROVIDER_IDS, type GatewayCallResult } from "./local-agent";
import { checkOf, getChecks, isCheckSkipped, startChecks, type ProviderCheck } from "./provider-check";
import { getPausedProviders, isProviderPaused, pausedMessage } from "./provider-state";

// Whether a provider is set up to answer: a cloud API needs an API key, a
// local CLI has to be installed (and signed in, where local-agent-gateway can
// tell, from its GET /auth), a website needs the gateway's Chrome. One that
// isn't is held like a paused one (requests get 503) and can't be resumed
// until it is set up; once it is, it goes by the owner's own pause switch
// again. Nothing is saved: the answer is worked out from the keys and the
// gateways' answers each time.
//
// Being set up isn't being able to answer, so a provider whose test chat failed
// is held too ("failing", see provider-check.ts). That one the owner can't
// resume either: a later test has to pass.
//
// "unknown" is for when the gateway can't be asked, or the CLI can't say. It
// never blocks: a gateway that is restarting, or an older one with no /auth,
// must not switch every CLI off.

export type SetupStatus = "ready" | "no-key" | "not-installed" | "signed-out" | "failing" | "unknown";

export type ProviderSetup = { status: SetupStatus; reason: string | null };

const READY: ProviderSetup = { status: "ready", reason: null };
const UNKNOWN: ProviderSetup = { status: "unknown", reason: null };

export const isBlocked = (setup: ProviderSetup) => setup.status !== "ready" && setup.status !== "unknown";

// A provider as GET /health lists it, and as GET /auth does: `signed_in` is
// true, false, or null when the CLI can't say.
type GatewayProvider = { installed?: boolean; error?: string | null };
type GatewayAuth = { signed_in?: boolean | null };
type GatewayView = {
  health: Record<string, GatewayProvider> | null;
  auth: Record<string, GatewayAuth> | null; // null: no answer, as from a gateway without /auth
};

const EMPTY: GatewayView = { health: null, auth: null };

// How to sign a CLI in on the server, for the reason the console shows.
const SIGN_IN_HINTS: Partial<Record<string, string>> = {
  claude: "run `claude auth login` there.",
  codex: "run `codex login` there.",
  antigravity: "run `agy` there and sign in.",
};

const OK_TTL_MS = 20_000;
const FAILED_TTL_MS = 5_000;
const WAIT_MS = 3_000; // a hung gateway must not hold up every request
const MAX_STALE_MS = 5 * 60_000; // an answer this old is no longer good enough to go on

type ViewCache = { at: number; value: GatewayView; inflight: Promise<GatewayView> | null };

// One cache per process, even if the bundler hands each route its own copy
// of this module.
const globalRef = globalThis as typeof globalThis & { __aiThunSetupView?: ViewCache };

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(resolve, () => resolve(fallback)).finally(() => clearTimeout(timer));
  });
}

function providersOf<T>(result: GatewayCallResult): Record<string, T> | null {
  const providers = (result.data as { providers?: Record<string, T> } | null)?.providers;
  return result.status === 200 && providers ? providers : null;
}

// Null when the gateway can't be asked at all (no /health). A gateway with no
// /auth (404) is fine: that only means no sign-in news. One whose /auth failed
// some other way (`authFailed`) has its earlier answer kept, see gatewayView.
async function fetchView(): Promise<{ view: GatewayView; authFailed: boolean } | null> {
  const [healthResult, authResult] = await Promise.all([health(), auth()]);
  const view = { health: providersOf<GatewayProvider>(healthResult), auth: providersOf<GatewayAuth>(authResult) };
  return view.health ? { view, authFailed: !view.auth && authResult.status !== 404 } : null;
}

// The gateway's answers, kept for a few seconds. A request doesn't wait for a
// refresh when it has an answer that's only a little old (a sign-in check can
// take seconds when the gateway's own copy has run out), and an answer that
// couldn't be refreshed is kept rather than flipping every CLI to "unknown".
// `force`: wait for a fresh one, for deciding whether a provider can be resumed.
function gatewayView(force = false): Promise<GatewayView> {
  const cache = (globalRef.__aiThunSetupView ??= { at: 0, value: EMPTY, inflight: null });
  const age = Date.now() - cache.at;
  if (!force && cache.at && age < (cache.value.health ? OK_TTL_MS : FAILED_TTL_MS)) return Promise.resolve(cache.value);
  cache.inflight ??= within(fetchView(), WAIT_MS, null).then((fetched) => {
    cache.inflight = null;
    if (fetched) {
      const keepAuth = fetched.authFailed && cache.at && Date.now() - cache.at < MAX_STALE_MS;
      cache.value = keepAuth ? { ...fetched.view, auth: cache.value.auth } : fetched.view;
      cache.at = Date.now();
    } else if (!cache.at || Date.now() - cache.at >= MAX_STALE_MS) {
      cache.value = EMPTY;
      cache.at = Date.now();
    }
    return cache.value;
  });
  return !force && cache.at && age < MAX_STALE_MS ? Promise.resolve(cache.value) : cache.inflight;
}

function cloudSetup(provider: (typeof PROVIDER_IDS)[number]): ProviderSetup {
  const { count, total, envName } = keySetup(provider);
  if (count > 0) return READY;
  return {
    status: "no-key",
    reason:
      total > 0
        ? "Every API key is switched off: switch one on, on the Manage page."
        : `No API key is set: add one on the Manage page, or put ${envName} in the server's environment and restart.`,
  };
}

function localSetup(provider: (typeof LOCAL_AGENT_PROVIDER_IDS)[number], view: GatewayView): ProviderSetup {
  const entry = view.health?.[provider];
  if (!entry || entry.error) return UNKNOWN;
  const web = isWebChat(provider);
  if (entry.installed === false) {
    return {
      status: "not-installed",
      reason: web ? "Chrome isn't installed on the server, and this site is read through it." : `The ${provider} CLI isn't installed on the server.`,
    };
  }
  if (view.auth?.[provider]?.signed_in === false) {
    const hint = SIGN_IN_HINTS[provider];
    const reason = web ? `${provider} isn't signed in in the gateway's Chrome.` : `The ${provider} CLI isn't signed in on the server`;
    return { status: "signed-out", reason: web || !hint ? `${reason}.` : `${reason}: ${hint}` };
  }
  return READY;
}

// Whether the provider has what it needs: key, CLI, sign-in. Nothing about
// whether it answers.
export async function staticSetup(provider: string, force = false): Promise<ProviderSetup> {
  if (isProviderId(provider)) return cloudSetup(provider);
  if (isLocalAgentProviderId(provider)) return localSetup(provider, await gatewayView(force));
  return READY; // not a provider: the route says so
}

// A provider that is set up but whose last test chat failed.
function withCheck(setup: ProviderSetup, check: ProviderCheck, provider: string): ProviderSetup {
  return !isBlocked(setup) && check.status === "failing" && !isCheckSkipped(provider)
    ? { status: "failing", reason: check.reason ?? "its last test chat failed" }
    : setup;
}

export async function providerSetup(provider: string, force = false): Promise<ProviderSetup> {
  return withCheck(await staticSetup(provider, force), checkOf(provider), provider);
}

export async function getProviderSetup(): Promise<Record<string, ProviderSetup>> {
  const view = await gatewayView();
  const checks = getChecks();
  const setup = {
    ...Object.fromEntries(PROVIDER_IDS.map((id) => [id, cloudSetup(id)])),
    ...Object.fromEntries(LOCAL_AGENT_PROVIDER_IDS.map((id) => [id, localSetup(id, view)])),
  };
  return Object.fromEntries(Object.entries(setup).map(([id, s]) => [id, withCheck(s, checks[id], id)]));
}

// Starts the test chats (see provider-check.ts) if they aren't running yet.
// Called when the server starts, and again wherever the state is read: the
// first call does the work.
export function startProviderChecks(): void {
  startChecks(async (provider) => isBlocked(await staticSetup(provider)));
}

export type ProviderState = {
  paused: string[]; // the providers that turn requests away, whatever the reason
  manual: string[]; // the ones the owner paused
  setup: Record<string, ProviderSetup>;
  checks: Record<string, Omit<ProviderCheck, "checkedAt"> & { checkedAt: string | null; skipped: boolean }>;
};

// `paused`: the providers the owner paused, those that aren't set up and those
// whose test chat failed. `setup` says why, for the console.
export async function getProviderState(): Promise<ProviderState> {
  startProviderChecks();
  const [manual, setup] = await Promise.all([getPausedProviders(), getProviderSetup()]);
  const paused = new Set(manual);
  for (const [id, s] of Object.entries(setup)) if (isBlocked(s)) paused.add(id);
  const checks = Object.fromEntries(
    Object.entries(getChecks()).map(([id, c]) => [
      id,
      { ...c, checkedAt: c.checkedAt ? new Date(c.checkedAt).toISOString() : null, skipped: isCheckSkipped(id) },
    ]),
  );
  return { paused: [...paused].sort(), manual: [...manual].sort(), setup, checks };
}

// Why a request for this provider is turned away (the 503's message), or null.
export async function providerBlock(provider: string): Promise<string | null> {
  startProviderChecks();
  const setup = await providerSetup(provider);
  if (setup.status === "failing") return `Provider "${provider}" isn't responding: ${setup.reason}`;
  if (isBlocked(setup)) return `Provider "${provider}" isn't set up. ${setup.reason}`;
  return (await isProviderPaused(provider)) ? pausedMessage(provider) : null;
}
