import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Where ai-thun keeps what has to outlive a restart: paused providers and the
// usage ledger. Outside the project folder, so a deploy (rsync --delete)
// can't wipe it.
export const STATE_DIR =
  process.env.AI_THUN_STATE_DIR || path.join(os.homedir(), ".local", "state", "ai-thun");

export function statePath(name: string): string {
  return path.join(STATE_DIR, name);
}

function serialize(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// Write-then-rename, so a crash mid-write can't leave a half-written file.
// `tag` keeps concurrent writers of the same file off each other's temp file.
// `mode`: the file's permissions, for one that holds secrets (0o600: only this user reads it).
export async function writeJsonAtomic(file: string, data: unknown, tag = "a", mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tag}.tmp`;
  await writeFile(tmp, serialize(data), mode === undefined ? undefined : { mode });
  await rename(tmp, file);
}

export function writeJsonAtomicSync(file: string, data: unknown, tag = "s"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tag}.tmp`;
  writeFileSync(tmp, serialize(data));
  renameSync(tmp, file);
}
