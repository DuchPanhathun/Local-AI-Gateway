// The text side of the API keys an admin adds from the console (lib/provider-keys.ts keeps them): what a pasted
// block is split into, whether a piece can be a key, how a key is shown without being given away, and what a
// provider's answer to a key check means. No imports, so scripts/test-keys.mts can load it with plain node.

export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 512;

// What was pasted → the keys in it, in order, each once. A key can be on its own line, or several can share one
// separated by spaces, commas or semicolons; lines copied from a .env file (`GROQ_API_KEY3=gsk_…`, `export …`,
// with or without quotes) lose their name, and `#` comment lines are skipped.
export function splitKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    for (const piece of line.replace(/(^|\s)export\s+(?=[A-Z][A-Z0-9_]*=)/g, "$1").split(/[\s,;]+/)) {
      const key = piece
        .replace(/^[A-Z][A-Z0-9_]{2,}=/, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

// Why a piece of text can't be an API key, or null. Only what no provider's key looks like: the provider decides
// the rest when the key is checked with it.
export function keyProblem(key: string): string | null {
  if (key.length < MIN_KEY_LENGTH) return `too short to be an API key (under ${MIN_KEY_LENGTH} characters)`;
  if (key.length > MAX_KEY_LENGTH) return `too long to be an API key (over ${MAX_KEY_LENGTH} characters)`;
  if (!/^[\x21-\x7e]+$/.test(key)) return "has spaces or characters an API key doesn't have";
  return null;
}

// A key as the console shows it: enough to tell keys apart and to find one in the provider's own dashboard, never
// enough to use it.
export function maskKey(key: string): string {
  if (key.length >= 20) return `${key.slice(0, 4)}…${key.slice(-4)}`;
  if (key.length >= 12) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return "••••";
}

export type KeyCheckResult = "valid" | "rejected" | "unknown";

// What a provider's answer to GET /models with a new key says about the key. 429 and 402 are answers a real key
// gets too (its quota is used up, its account needs billing), so they pass. Only a refusal of the key itself fails
// it: 401 and 403 everywhere, and Google's 400 "API key not valid". Anything else (the provider is down, a path
// that moved) says nothing about the key, so it is added with a warning, not turned away. The detail is written
// here from the status alone: a provider's own text is never passed along.
export function classifyKeyCheck(status: number, body = ""): { result: KeyCheckResult; detail: string } {
  if (status >= 200 && status < 300) return { result: "valid", detail: "The provider accepted it." };
  if (status === 429) return { result: "valid", detail: "The provider accepted it (it is rate limited right now)." };
  if (status === 402) return { result: "valid", detail: "The provider accepted it, but the account needs billing set up." };
  if (status === 401 || status === 403) return { result: "rejected", detail: `The provider refused it (HTTP ${status}).` };
  // Google's OpenAI-compatible endpoint answers a bad key with 400 "Invalid Auth key." (its native one with 401).
  if (status === 400 && /invalid[^"]{0,20}key|key[^"]{0,20}(invalid|not valid)|incorrect api[_ ]?key|API_KEY_INVALID/i.test(body)) {
    return { result: "rejected", detail: "The provider says it is not a valid API key." };
  }
  return { result: "unknown", detail: `Couldn't be checked: the provider answered HTTP ${status}.` };
}
