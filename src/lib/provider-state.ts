import { readFile } from "node:fs/promises";
import { statePath, writeJsonAtomic } from "./state-files";

// Providers the owner has paused from the console's Manage page. A paused
// provider turns every request away with 503 until it's resumed; its keys
// and CLI logins are left alone. Kept in the state folder (see state-files),
// so neither a restart nor a deploy resets it.
const STATE_FILE = statePath("providers.json");

// Read on every call instead of cached: the file is a few bytes, and every
// route then sees a change the moment it's saved.
export async function getPausedProviders(): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(STATE_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Can't read ${STATE_FILE}; treating every provider as active:`, err);
    }
    return [];
  }
  try {
    const paused = (JSON.parse(raw) as { paused?: unknown }).paused;
    return Array.isArray(paused) ? paused.filter((p): p is string => typeof p === "string") : [];
  } catch (err) {
    console.error(`${STATE_FILE} isn't valid JSON; treating every provider as active:`, err);
    return [];
  }
}

export async function isProviderPaused(provider: string): Promise<boolean> {
  return (await getPausedProviders()).includes(provider);
}

export function pausedMessage(provider: string): string {
  return `Provider "${provider}" is paused. Resume it on the Manage page of the Thun Murex console.`;
}

// Writes are chained so two quick toggles can't interleave their
// read-modify-write and lose one of the changes.
let lastWrite: Promise<unknown> = Promise.resolve();

export function setProviderPaused(provider: string, paused: boolean): Promise<string[]> {
  const write = lastWrite.then(async () => {
    const current = new Set(await getPausedProviders());
    if (paused) current.add(provider);
    else current.delete(provider);
    const list = [...current].sort();
    await writeJsonAtomic(STATE_FILE, { paused: list });
    return list;
  });
  lastWrite = write.catch(() => {});
  return write;
}
