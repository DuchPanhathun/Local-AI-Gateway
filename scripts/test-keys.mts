// The text side of the console's key management (src/lib/key-text.ts): what a pasted block turns into, which pieces
// can be keys, how a key is masked, and what a provider's answer to a key check means.
//   node --test scripts/test-keys.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Loaded by path, not imported: tsc (checking scripts/ with the rest) doesn't take a ".ts" import, and Node does.
const k = (await import(new URL("../src/lib/key-text.ts", import.meta.url).href)) as typeof import("../src/lib/key-text");

describe("keys in pasted text", () => {
  it("takes one per line, or several on a line, in order and once each", () => {
    assert.deepEqual(k.splitKeys("AQ.first-key-0001\nAQ.second-key-0002\r\n\nAQ.first-key-0001"), ["AQ.first-key-0001", "AQ.second-key-0002"]);
    assert.deepEqual(k.splitKeys("gsk_aaaaaaaa1, gsk_bbbbbbbb2; gsk_cccccccc3  gsk_dddddddd4"), ["gsk_aaaaaaaa1", "gsk_bbbbbbbb2", "gsk_cccccccc3", "gsk_dddddddd4"]);
  });

  it("takes lines copied from a .env file: names, export, quotes and comments go", () => {
    const pasted = ["# Google keys", 'GOOGLE_AI_STUDIO_API_KEY5="AQ.quoted-key-0005"', "export GROQ_API_KEY2='gsk_single-quoted-2'", "COARENA_API_KEY1=coa_plain_000001", "   "].join("\n");
    assert.deepEqual(k.splitKeys(pasted), ["AQ.quoted-key-0005", "gsk_single-quoted-2", "coa_plain_000001"]);
  });

  it("leaves a key that has = inside it alone, and one that starts like a name but isn't one", () => {
    assert.deepEqual(k.splitKeys("abc123def456ghi789=="), ["abc123def456ghi789=="]);
    assert.deepEqual(k.splitKeys("sk-live=abcdef0123456789"), ["sk-live=abcdef0123456789"]);
  });

  it("finds nothing in empty or comment-only text", () => {
    assert.deepEqual(k.splitKeys(""), []);
    assert.deepEqual(k.splitKeys("# nothing here\n   \n"), []);
  });
});

describe("what can't be a key", () => {
  it("refuses too short, too long and odd characters, and nothing else", () => {
    assert.match(k.keyProblem("short") ?? "", /too short/);
    assert.match(k.keyProblem("x".repeat(513)) ?? "", /too long/);
    assert.match(k.keyProblem("has space-0000") ?? "", /characters/);
    assert.match(k.keyProblem("naïve-key-000000") ?? "", /characters/);
    assert.equal(k.keyProblem("AQ.Ab8RN6Kexample-key_0123456789"), null);
    assert.equal(k.keyProblem("x".repeat(512)), null);
  });
});

describe("showing a key", () => {
  it("shows enough to tell keys apart and never the whole key", () => {
    const long = "AQ.Ab8RN6Kexample-key_0123456789";
    assert.equal(k.maskKey(long), "AQ.A…6789");
    assert.ok(!k.maskKey(long).includes("example"));
    assert.equal(k.maskKey("gsk_abcdefgh"), "gs…gh");
    assert.equal(k.maskKey("short-key"), "••••");
    for (const key of [long, "gsk_abcdefgh", "short-key", "x".repeat(300)]) assert.ok(k.maskKey(key).length < key.length || key.length < 5);
  });
});

describe("what a provider's answer to a key check means", () => {
  it("accepts a key the provider takes, or that a real key would get (rate limited, needs billing)", () => {
    for (const status of [200, 204, 429, 402]) assert.equal(k.classifyKeyCheck(status).result, "valid", String(status));
  });

  it("rejects what the provider refuses: 401, 403 and Google's 400 for a key that isn't valid", () => {
    for (const status of [401, 403]) assert.equal(k.classifyKeyCheck(status).result, "rejected", String(status));
    const google = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}';
    assert.equal(k.classifyKeyCheck(400, google).result, "rejected");
    assert.equal(k.classifyKeyCheck(400, '{"error":"Incorrect API key provided"}').result, "rejected");
    // What Google's OpenAI-compatible endpoint really answers to a key that doesn't exist (2026-11-14).
    assert.equal(k.classifyKeyCheck(400, '{\n  "error": {\n    "code": 400,\n    "message": "Invalid Auth key.",\n    "status": "INVALID_ARGUMENT"\n  }\n}').result, "rejected");
  });

  it("says nothing either way for a provider that is down or a 400 that isn't about the key", () => {
    for (const status of [404, 500, 502, 503]) assert.equal(k.classifyKeyCheck(status).result, "unknown", String(status));
    assert.equal(k.classifyKeyCheck(400, '{"error":"bad request"}').result, "unknown");
  });

  it("writes its own detail, never the provider's text, which could echo the key", () => {
    const echo = k.classifyKeyCheck(400, "API key not valid: AQ.the-secret-key-itself");
    assert.ok(!echo.detail.includes("secret"));
  });
});
