import { readFileSync, renameSync } from "node:fs";
import { statePath, writeJsonAtomic } from "./state-files";

// The console Playground's saved chats, so a conversation can be picked up
// again later, from any browser. Each person signed in to the console has
// their own ("owner", or an admin's account id; see consoleUser in auth.ts).
// Held in memory and written to the state folder after every change.

const HISTORY_FILE = statePath("playground-history.json");
const MAX_CHATS = 200; // per person: past it, the longest-untouched go
export const MAX_CHAT_CHARS = 2_000_000; // one chat, as JSON
const TITLE_CHARS = 80;

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  finishReason?: string | null;
  isError?: boolean;
};

export type SavedChat = {
  id: string;
  title: string; // its first message, shortened
  provider: string;
  model: string; // "" for the provider's default
  sessionId: string | null; // a CLI's or web chat's own, to continue it
  workdir: string; // CLIs: where it ran ("" for the gateway's default)
  messages: ChatTurn[];
  createdAt: string;
  updatedAt: string;
};

export type ChatSummary = Pick<SavedChat, "id" | "title" | "provider" | "model" | "updatedAt"> & {
  turns: number;
};

type HistoryFile = { version: 1; people: Record<string, SavedChat[]> };

export class HistoryError extends Error {}

function load(): HistoryFile {
  let raw: string;
  try {
    raw = readFileSync(HISTORY_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Can't read ${HISTORY_FILE}; starting with no saved chats:`, err);
    }
    return { version: 1, people: {} };
  }
  try {
    const people = (JSON.parse(raw) as Partial<HistoryFile>).people;
    if (!people || typeof people !== "object") throw new Error("it has no `people`");
    return { version: 1, people };
  } catch (err) {
    // Set the unreadable file aside rather than overwrite it on the next save.
    const aside = `${HISTORY_FILE}.unreadable-${Date.now()}`;
    try {
      renameSync(HISTORY_FILE, aside);
    } catch {}
    console.error(`${HISTORY_FILE} isn't a chat history; moved it to ${aside}:`, err);
    return { version: 1, people: {} };
  }
}

type Store = { file: HistoryFile; saving: Promise<unknown> };

// One store per process, even if the bundler hands each route its own copy
// of this module.
const globalRef = globalThis as typeof globalThis & { __aiThunPlaygroundHistory?: Store };

function store(): Store {
  globalRef.__aiThunPlaygroundHistory ??= { file: load(), saving: Promise.resolve() };
  return globalRef.__aiThunPlaygroundHistory;
}

// Writes go one after another, each with everything changed so far.
function save(s: Store): Promise<void> {
  const write = s.saving.then(() => writeJsonAtomic(HISTORY_FILE, s.file));
  s.saving = write.catch(() => {});
  return write;
}

function summary(chat: SavedChat): ChatSummary {
  const { id, title, provider, model, updatedAt } = chat;
  return { id, title, provider, model, updatedAt, turns: chat.messages.length };
}

export function listChats(person: string): ChatSummary[] {
  return (store().file.people[person] ?? [])
    .map(summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getChat(person: string, id: string): SavedChat | null {
  return store().file.people[person]?.find((c) => c.id === id) ?? null;
}

export function validChatId(id: string | null): id is string {
  return !!id && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new HistoryError(`\`${field}\` must be a string`);
  if (value.length > max) throw new HistoryError(`\`${field}\` is longer than ${max} characters`);
  return value;
}

// A chat as the Playground sends it: {provider, model, sessionId, workdir,
// messages}. Only the fields the Playground uses are kept.
export function parseChat(body: unknown): Omit<SavedChat, "id" | "title" | "createdAt" | "updatedAt"> {
  const b = (body ?? {}) as Record<string, unknown>;
  const provider = text(b.provider, "provider", 40);
  if (!/^[a-z0-9-]+$/.test(provider)) throw new HistoryError("`provider` isn't a provider id");
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    throw new HistoryError("`messages` must be a list with at least one message");
  }
  const messages = b.messages.map((m: Record<string, unknown>, i): ChatTurn => {
    if (m?.role !== "user" && m?.role !== "assistant") {
      throw new HistoryError(`messages[${i}].role must be "user" or "assistant"`);
    }
    return {
      role: m.role,
      content: text(m.content, `messages[${i}].content`, MAX_CHAT_CHARS),
      ...(typeof m.thinking === "string" ? { thinking: m.thinking } : {}),
      ...(typeof m.finishReason === "string" || m.finishReason === null ? { finishReason: m.finishReason } : {}),
      ...(m.isError === true ? { isError: true } : {}),
    };
  });
  return {
    provider,
    model: b.model === undefined ? "" : text(b.model, "model", 200),
    sessionId: b.sessionId === undefined || b.sessionId === null ? null : text(b.sessionId, "sessionId", 200),
    workdir: b.workdir === undefined ? "" : text(b.workdir, "workdir", 1000),
    messages,
  };
}

function titleOf(messages: ChatTurn[]): string {
  const first = (messages.find((m) => m.role === "user")?.content ?? "").replace(/\s+/g, " ").trim();
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1)}…` : first || "Untitled chat";
}

// Saves a chat under `id`, new or not, keeping when it was started.
export async function saveChat(
  person: string,
  id: string,
  chat: Omit<SavedChat, "id" | "title" | "createdAt" | "updatedAt">,
): Promise<ChatSummary> {
  const s = store();
  const now = new Date().toISOString();
  const chats = s.file.people[person] ?? [];
  const before = chats.find((c) => c.id === id);
  const saved: SavedChat = {
    id,
    title: titleOf(chat.messages),
    ...chat,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  const kept = [saved, ...chats.filter((c) => c.id !== id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CHATS);
  s.file.people[person] = kept;
  await save(s);
  return summary(saved);
}

export async function deleteChat(person: string, id: string): Promise<boolean> {
  const s = store();
  const chats = s.file.people[person] ?? [];
  if (!chats.some((c) => c.id === id)) return false;
  s.file.people[person] = chats.filter((c) => c.id !== id);
  await save(s);
  return true;
}
