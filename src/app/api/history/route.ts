import { NextRequest, NextResponse } from "next/server";
import { checkAccess, consoleUser, refusal } from "@/lib/auth";
import {
  deleteChat,
  getChat,
  HistoryError,
  listChats,
  MAX_CHAT_CHARS,
  parseChat,
  saveChat,
  validChatId,
} from "@/lib/playground-history";

// The console Playground's saved chats, each signed-in person's own (see
// lib/playground-history). For the console's own page only: no CORS.

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// The person whose history this is, or the refusal.
async function personOf(req: NextRequest): Promise<string | Response> {
  const access = await checkAccess(req, "owner");
  return access.ok ? consoleUser(req) : refusal(access, NO_STORE);
}

// GET /api/history → {chats: [{id, title, provider, model, updatedAt, turns}]},
// most recent first. GET /api/history?id=… → that chat, with its messages.
export async function GET(req: NextRequest) {
  const person = await personOf(req);
  if (person instanceof Response) return person;
  const id = req.nextUrl.searchParams.get("id");
  if (id === null) return NextResponse.json({ chats: listChats(person) }, { headers: NO_STORE });
  const chat = validChatId(id) ? getChat(person, id) : null;
  return chat ? NextResponse.json(chat, { headers: NO_STORE }) : fail(404, `No saved chat with id "${id}"`);
}

// PUT /api/history?id=… {provider, model, sessionId, workdir, messages} saves
// the chat (new, or replacing what's under that id) → its summary.
export async function PUT(req: NextRequest) {
  const person = await personOf(req);
  if (person instanceof Response) return person;
  const id = req.nextUrl.searchParams.get("id");
  if (!validChatId(id)) return fail(400, "Provide the chat's id as ?id= (8 to 64 letters, digits or dashes)");
  const raw = await req.text();
  if (raw.length > MAX_CHAT_CHARS) return fail(413, "This chat is too long to save");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Request body must be valid JSON");
  }
  try {
    return NextResponse.json(await saveChat(person, id, parseChat(body)), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof HistoryError) return fail(400, err.message);
    return fail(500, `Couldn't save the chat: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// DELETE /api/history?id=…
export async function DELETE(req: NextRequest) {
  const person = await personOf(req);
  if (person instanceof Response) return person;
  const id = req.nextUrl.searchParams.get("id");
  if (!validChatId(id)) return fail(400, "Provide the chat's id as ?id=");
  try {
    if (!(await deleteChat(person, id))) return fail(404, `No saved chat with id "${id}"`);
    return NextResponse.json({ deleted: id }, { headers: NO_STORE });
  } catch (err) {
    return fail(500, `Couldn't delete the chat: ${err instanceof Error ? err.message : String(err)}`);
  }
}
