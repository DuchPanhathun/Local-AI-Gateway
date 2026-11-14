import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { statePath, writeJsonAtomic } from "./state-files";

// The API keys an admin adds from the console's Manage page, and which keys (these or the ones in .env) are
// switched off. Kept in the state folder, outside the project, so a deploy doesn't wipe them; the file is readable
// by this user only. The keys in .env stay where they are: they can be switched off here but not changed.
//
// collectKeys (lib/ai-providers.ts) reads this on every request, synchronously, so a change applies to the next
// request with no restart. The file is read again only when it has changed on disk.

const FILE = statePath("provider-keys.json");

// Per provider; .env's own limit (1..50) is separate.
export const MAX_WEB_KEYS_PER_PROVIDER = 100;

export type WebKey = {
  id: string;
  key: string;
  label: string;
  addedAt: string;
};

type Store = { keys: Record<string, WebKey[]>; disabled: string[] };

// What the usage ledger, the quotas and the cooldowns call a key added here: the name an environment variable
// would have had. Never the key.
export const webKeyName = (id: string) => `web-${id}`;

const EMPTY: Store = { keys: {}, disabled: [] };

// Why the file couldn't be read, without quoting it: a JSON error repeats a snippet of the text, which here is keys.
const why = (err: unknown) => (err instanceof SyntaxError ? "it isn't valid JSON" : ((err as NodeJS.ErrnoException).code ?? "it can't be read"));

function parse(raw: string): Store {
  const data = JSON.parse(raw) as { keys?: unknown; disabled?: unknown };
  const keys: Record<string, WebKey[]> = {};
  if (data.keys && typeof data.keys === "object") {
    for (const [provider, list] of Object.entries(data.keys as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      keys[provider] = list.filter(
        (k): k is WebKey =>
          !!k && typeof k === "object" && typeof (k as WebKey).id === "string" && typeof (k as WebKey).key === "string" && !!(k as WebKey).key
      ).map((k) => ({ id: k.id, key: k.key, label: typeof k.label === "string" ? k.label : "", addedAt: typeof k.addedAt === "string" ? k.addedAt : "" }));
    }
  }
  const disabled = Array.isArray(data.disabled) ? data.disabled.filter((d): d is string => typeof d === "string") : [];
  return { keys, disabled };
}

// One cache per process, even if the bundler hands each route its own copy of this module. Checked against the
// file's size and modification time, so a write from any copy is seen by all.
type Cache = { stamp: string; store: Store };
const globalRef = globalThis as typeof globalThis & { __aiThunKeyStore?: Cache };
let warned = "";

function load(): Store {
  let stamp: string;
  try {
    const st = statSync(FILE);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Can't read ${FILE}: ${why(err)}`);
    return EMPTY;
  }
  const cached = globalRef.__aiThunKeyStore;
  if (cached && cached.stamp === stamp) return cached.store;
  try {
    const store = parse(readFileSync(FILE, "utf8"));
    globalRef.__aiThunKeyStore = { stamp, store };
    return store;
  } catch (err) {
    if (warned !== stamp) {
      warned = stamp;
      console.error(`${FILE}: ${why(err)}; the keys added from the console are not used until it is fixed.`);
    }
    return EMPTY;
  }
}

// The keys added here for a provider, for collectKeys: all of them, switched off or not.
export function storedKeys(provider: string): WebKey[] {
  return load().keys[provider] ?? [];
}

export function isKeyDisabled(name: string): boolean {
  return load().disabled.includes(name);
}

// Writes are chained so two quick changes can't interleave their read-modify-write and lose one. A file that is
// there but can't be read is never written over: that would throw away the keys in it.
let lastWrite: Promise<unknown> = Promise.resolve();

function change<T>(apply: (store: Store) => T): Promise<T> {
  const write = lastWrite.then(async () => {
    let store: Store;
    try {
      store = parse(readFileSync(FILE, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`${FILE} can't be read (${why(err)}), so it was left as it is. Fix or remove it first.`);
      }
      store = { keys: {}, disabled: [] };
    }
    const result = apply(store);
    await writeJsonAtomic(FILE, store, "keys", 0o600);
    return result;
  });
  lastWrite = write.catch(() => {});
  return write;
}

// Adds keys to a provider. The caller has checked them (not a duplicate, looks like a key) and the limit.
export function addWebKeys(provider: string, keys: string[], label: string): Promise<WebKey[]> {
  return change((store) => {
    const now = new Date().toISOString();
    const list = (store.keys[provider] ??= []);
    const added = keys.map((key) => ({ id: randomBytes(4).toString("hex"), key, label, addedAt: now }));
    list.push(...added);
    return added;
  });
}

// Removes a key that was added here. False when there is no such key.
export function removeWebKey(provider: string, id: string): Promise<boolean> {
  return change((store) => {
    const list = store.keys[provider] ?? [];
    const index = list.findIndex((k) => k.id === id);
    if (index < 0) return false;
    list.splice(index, 1);
    if (list.length === 0) delete store.keys[provider];
    store.disabled = store.disabled.filter((name) => name !== webKeyName(id));
    return true;
  });
}

// Switches a key (by its name) off or on: a key that is off is skipped as if it weren't set.
export function setKeyDisabled(name: string, disabled: boolean): Promise<void> {
  return change((store) => {
    const rest = store.disabled.filter((n) => n !== name);
    store.disabled = (disabled ? [...rest, name] : rest).sort();
  });
}
