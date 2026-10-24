import { createHash, randomBytes, timingSafeEqual } from "crypto";

// Dynamically-generated API tokens, stored in Vercel Edge Config so every
// serverless instance sees the same list without needing to redeploy.
// Reads go through Edge Config's read API (fast, uses the read-only
// EDGE_CONFIG connection string). Writes go through Vercel's management API
// (needs VERCEL_API_TOKEN — see README for the security trade-off: this is
// a full-account-scope token, not resource-scoped, because Vercel doesn't
// support minting narrower ones programmatically).

export type ApiToken = {
  id: string;
  token: string;
  label: string;
  createdAt: string;
};

const EDGE_CONFIG_ITEMS_KEY = "apiTokens";

function edgeConfigReadUrl(key: string): string {
  const base = process.env.EDGE_CONFIG;
  if (!base) throw new Error("EDGE_CONFIG is not set");
  const [url, query] = base.split("?");
  return `${url}/item/${key}?${query}`;
}

export async function readTokens(): Promise<ApiToken[]> {
  const res = await fetch(edgeConfigReadUrl(EDGE_CONFIG_ITEMS_KEY), {
    cache: "no-store",
  });
  if (res.status === 404) return []; // key not created yet
  if (!res.ok) throw new Error(`Edge Config read failed: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function writeTokens(tokens: ApiToken[]): Promise<void> {
  const { EDGE_CONFIG_ID, VERCEL_API_TOKEN, VERCEL_TEAM_ID } = process.env;
  if (!EDGE_CONFIG_ID || !VERCEL_API_TOKEN) {
    throw new Error("EDGE_CONFIG_ID / VERCEL_API_TOKEN are not set");
  }
  const teamQuery = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "";
  const res = await fetch(
    `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items${teamQuery}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${VERCEL_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [{ operation: "upsert", key: EDGE_CONFIG_ITEMS_KEY, value: tokens }],
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Edge Config write failed: HTTP ${res.status} ${body}`);
  }
}

export async function createToken(label: string): Promise<ApiToken> {
  const tokens = await readTokens();
  const entry: ApiToken = {
    id: randomBytes(8).toString("hex"),
    token: `sk-ai-thun-${randomBytes(24).toString("hex")}`,
    label: label || "untitled",
    createdAt: new Date().toISOString(),
  };
  await writeTokens([...tokens, entry]);
  return entry;
}

export async function revokeToken(id: string): Promise<boolean> {
  const tokens = await readTokens();
  const next = tokens.filter((t) => t.id !== id);
  if (next.length === tokens.length) return false; // nothing matched
  await writeTokens(next);
  return true;
}

export function maskToken(token: string): string {
  return token.length <= 8 ? "••••" : `${token.slice(0, 10)}…${token.slice(-4)}`;
}

// Used on the hot /api/chat auth path — must never throw. If Edge Config is
// unreachable or unconfigured, generated tokens just don't work (the owner's
// APP_API_KEY still does), rather than taking the whole endpoint down.
export async function isValidGeneratedToken(bearer: string): Promise<boolean> {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  try {
    const tokens = await readTokens();
    const wanted = digest(bearer);
    return tokens.some((t) => timingSafeEqual(digest(t.token), wanted)); // no early exit on a near match
  } catch {
    return false;
  }
}
