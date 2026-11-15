// The prices the gateway charges for Coarena's models (src/lib/pricing.ts), checked against what Coarena itself billed.
// The rows below are real calls from its per-call history (GET /api/v1/requests, 2026-11-15): the model, the tokens it
// reported and the cost_usd it charged. A price is right when input x input price + output x output price comes out
// at that cost to the millionth of a dollar (cached tokens at the full input price, reasoning tokens counted as output).
//   node --test scripts/test-pricing.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Loaded by path, not imported: tsc (checking scripts/ with the rest) doesn't take a ".ts" import, and Node does.
const p = (await import(new URL("../src/lib/pricing.ts", import.meta.url).href)) as typeof import("../src/lib/pricing");

// model, input tokens, output tokens, of the input cached, of the output reasoning, cost_usd
const BILLED: [string, number, number, number, number, number][] = [
  ["gemini-4-carbon", 9619, 23, 5297, 0, 0.019468],
  ["gemini-4-carbon", 11055, 23, 7321, 0, 0.02234],
  ["gemini-4-carbon", 8156, 22, 0, 0, 0.016532],
  ["gemini-4-carbon", 8116, 50, 0, 34, 0.016732],
  ["claude-sonnet-5-5", 8685, 57, 0, 0, 0.01794],
  ["claude-sonnet-5-5", 11208, 306, 0, 0, 0.025476],
  ["claude-sonnet-5-5", 16282, 138, 0, 0, 0.033944],
  ["claude-sonnet-5-5", 7818, 84, 0, 0, 0.016476],
  ["claude-fable-5-2", 18, 17, 0, 13, 0.000824],
  ["claude-fable-5-2", 141152, 7479, 0, 1183, 1.428376],
  ["claude-fable-5-2", 130706, 6744, 0, 248, 1.315408],
  ["claude-fable-5-2", 80858, 6880, 0, 1087, 0.922064],
  ["claude-opus-5-5", 75925, 8192, 0, 8192, 0.46754],
];

describe("Coarena's prices against its own bills", () => {
  for (const [model, input, output, cached, reasoning, billed] of BILLED) {
    it(`${model}: ${input} in (${cached} cached), ${output} out (${reasoning} reasoning) cost $${billed}`, () => {
      const cost = p.calculateUsageCost("coarena", model, input, output).totalCost;
      assert.ok(Math.abs(cost - billed) < 0.0000005, `${model} came to $${cost}, Coarena billed $${billed}`);
    });
  }

  it("charges Gemini 4 Carbon its own price, not the provider's (Claude Fable 5.2's, four times as much)", () => {
    const own = p.calculateUsageCost("coarena", "gemini-4-carbon", 1_000_000, 1_000_000);
    assert.equal(own.inputCost, 2);
    assert.equal(own.outputCost, 10);
    const fallback = p.calculateUsageCost("coarena", "grok-4-7", 1_000_000, 1_000_000);
    assert.equal(fallback.inputCost, 8, "a Coarena model with no row is still charged at the provider's rate");
  });

  it("matches the model id however the caller writes its case", () => {
    assert.equal(p.calculateUsageCost("coarena", "Gemini-4-Carbon", 1_000_000, 0).totalCost, 2);
  });
});

describe("which prices are the model's own", () => {
  it("knows a model with a row of its own from one that falls back to its provider's", () => {
    assert.equal(p.hasSpecificRate("gemini-4-carbon"), true);
    assert.equal(p.hasSpecificRate("Claude-Opus-5-5"), true);
    assert.equal(p.hasSpecificRate("kimi-k3"), false, "seen once: input and output price can't be told apart yet");
    assert.equal(p.hasSpecificRate("grok-4-7"), false);
    assert.equal(p.hasSpecificRate(""), false);
    assert.equal(p.hasSpecificRate(undefined), false);
  });

  it("doesn't take an object's own property names for models", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(p.hasSpecificRate(name), false, name);
  });
});
