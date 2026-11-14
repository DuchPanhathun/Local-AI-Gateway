import { NextRequest, NextResponse } from "next/server";
import { describeKeys, hasKey, isProviderId, PROVIDER_IDS, verifyKey, type KeyInfo, type ProviderId } from "@/lib/ai-providers";
import { keyProblem, maskKey, splitKeys } from "@/lib/key-text";
import { addWebKeys, MAX_WEB_KEYS_PER_PROVIDER, removeWebKey, setKeyDisabled, webKeyName } from "@/lib/provider-keys";
import { checkAccess, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: CORS_HEADERS });

// A request adds at most this many keys: a pasted list, not a file.
const MAX_PER_REQUEST = 200;
const CHECKS_AT_ONCE = 5;

type Listed = { provider: ProviderId; keys: KeyInfo[]; active: number };

const list = (provider: ProviderId): Listed => {
  const keys = describeKeys(provider);
  return { provider, keys, active: keys.filter((k) => !k.disabled).length };
};

// The API keys of the cloud providers (SEA-LION, Cerebras, Groq, Coarena, Google AI Studio), for the owner only:
// the keys in the server's environment (read-only here; they can be switched off) and the ones added from the
// console. A key's value is never sent back, only a masked form (`AQ.A…x1Yz`), and it isn't written to any log.
// A change applies to the next request, with no restart.
//
// GET                          → {providers: [{provider, active, keys: [{name, source, masked, disabled, …}]}],
//                                 limits: {perProvider}}
// POST   {provider, keys, label?, verify?, force?}
//        `keys` is text or an array: keys separated by lines, spaces or commas (lines pasted from a .env file work).
//        Each is checked with the provider first (`verify`, on unless false), and one the provider refuses is not
//        added unless `force` is true. → {results: [{masked, status, detail}], added, keys, active}; status is
//        added | duplicate | invalid | rejected | limit. 200 when any was added, else 422.
// PATCH  {provider, name, disabled}   switches a key off or on (any key, including ones in the environment)
// DELETE ?provider=&id=               removes a key that was added from the console (not one in the environment)
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  return NextResponse.json(
    { providers: PROVIDER_IDS.map(list), limits: { perProvider: MAX_WEB_KEYS_PER_PROVIDER } },
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
  );
}

type Result = { masked: string; status: "added" | "duplicate" | "invalid" | "rejected" | "limit"; detail: string };

export async function POST(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  const body = (await req.json().catch(() => null)) as {
    provider?: unknown;
    keys?: unknown;
    label?: unknown;
    verify?: unknown;
    force?: unknown;
  } | null;
  if (!body) return fail(400, "Request body must be valid JSON");
  const provider = String(body.provider ?? "");
  if (!isProviderId(provider)) return fail(400, `Unknown provider "${provider}". Supported: ${PROVIDER_IDS.join(", ")}`);

  const text = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === "string").join("\n") : body.keys;
  if (typeof text !== "string") return fail(400, "Provide `keys`: the API key, or several, as text or an array");
  const candidates = splitKeys(text);
  if (candidates.length === 0) return fail(400, "No API key found in `keys`");
  if (candidates.length > MAX_PER_REQUEST) return fail(400, `Add at most ${MAX_PER_REQUEST} keys at a time (${candidates.length} given)`);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  const verify = body.verify !== false;
  const force = body.force === true;

  // Decide each key, checking the ones that look right with the provider a few at a time.
  const results: Result[] = new Array(candidates.length);
  const toCheck: number[] = [];
  candidates.forEach((key, i) => {
    const masked = maskKey(key);
    const problem = keyProblem(key);
    if (problem) results[i] = { masked, status: "invalid", detail: `Not added: ${problem}.` };
    else if (hasKey(provider, key)) results[i] = { masked, status: "duplicate", detail: "Already set for this provider." };
    else toCheck.push(i);
  });

  const accepted = new Set<number>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CHECKS_AT_ONCE, toCheck.length) }, async () => {
      while (next < toCheck.length) {
        const i = toCheck[next++];
        const masked = maskKey(candidates[i]);
        const check = verify ? await verifyKey(provider, candidates[i]) : null;
        if (check?.result === "rejected" && !force) {
          results[i] = { masked, status: "rejected", detail: `Not added. ${check.detail}` };
        } else {
          accepted.add(i);
          results[i] = { masked, status: "added", detail: check ? check.detail : "Added without checking." };
        }
      }
    })
  );

  // Over the limit: the first ones in order are kept.
  const room = Math.max(0, MAX_WEB_KEYS_PER_PROVIDER - list(provider).keys.filter((k) => k.source === "web").length);
  const keep = [...accepted].sort((a, b) => a - b);
  for (const i of keep.slice(room)) {
    accepted.delete(i);
    results[i] = { masked: results[i].masked, status: "limit", detail: `Not added: at most ${MAX_WEB_KEYS_PER_PROVIDER} keys can be added from the console.` };
  }

  try {
    if (accepted.size > 0) await addWebKeys(provider, [...accepted].sort((a, b) => a - b).map((i) => candidates[i]), label);
  } catch (err) {
    return fail(500, `Couldn't save the keys: ${err instanceof Error ? err.message : String(err)}`);
  }
  const now = list(provider);
  return NextResponse.json({ results, added: accepted.size, keys: now.keys, active: now.active }, { status: accepted.size > 0 ? 200 : 422, headers: CORS_HEADERS });
}

export async function PATCH(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  const body = (await req.json().catch(() => null)) as { provider?: unknown; name?: unknown; disabled?: unknown } | null;
  const provider = String(body?.provider ?? "");
  if (!isProviderId(provider)) return fail(400, `Unknown provider "${provider}". Supported: ${PROVIDER_IDS.join(", ")}`);
  if (typeof body?.disabled !== "boolean") return fail(400, "Provide `disabled` (true or false)");
  const name = String(body?.name ?? "");
  if (!describeKeys(provider).some((k) => k.name === name)) return fail(404, `${provider} has no key named "${name}"`);
  try {
    await setKeyDisabled(name, body.disabled);
  } catch (err) {
    return fail(500, `Couldn't save the change: ${err instanceof Error ? err.message : String(err)}`);
  }
  return NextResponse.json(list(provider), { headers: CORS_HEADERS });
}

export async function DELETE(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, CORS_HEADERS);
  const provider = req.nextUrl.searchParams.get("provider") ?? "";
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!isProviderId(provider)) return fail(400, `Provide the provider as ?provider= (${PROVIDER_IDS.join(", ")})`);
  if (!id) return fail(400, "Provide the key's id as ?id=");
  const key = describeKeys(provider).find((k) => k.id === id || k.name === id);
  if (key?.source === "env") {
    return fail(409, `${key.name} is set in the server's environment, so it can't be removed here. Switch it off instead, or remove it from the server's .env.`);
  }
  try {
    if (!(await removeWebKey(provider, id.startsWith("web-") ? id.slice(4) : id))) return fail(404, `${provider} has no key added here with id "${id}"`);
  } catch (err) {
    return fail(500, `Couldn't remove the key: ${err instanceof Error ? err.message : String(err)}`);
  }
  return NextResponse.json({ removed: webKeyName(id.replace(/^web-/, "")), ...list(provider) }, { headers: CORS_HEADERS });
}
