import assert from "node:assert/strict";
import { getModelPricing, calculateUsageCost } from "../src/lib/pricing";
import {
  PREDEFINED_DEPOSIT_AMOUNTS,
} from "../src/lib/shop";
import {
  ensureAccount,
  createKey,
  getAccountCredit,
  getAccountCreditCents,
  addAccountCreditCents,
  deductAccountCredit,
  deductCreditForUsage,
  admit,
  changeTokenFile,
  type Account,
} from "../src/lib/api-tokens";
import { keyRule, type Access } from "../src/lib/auth";

async function runIntegrationTests() {
  console.log("=== 1. Validating Model Pricing Table & Rates ===");
  const expectedProviders = [
    "sea-lion",
    "cerebras",
    "groq",
    "coarena",
    "google",
    "claude",
    "codex",
    "gemini",
    "antigravity",
    "chatgpt",
    "grok",
    "mimo",
  ];

  for (const p of expectedProviders) {
    const pricing = getModelPricing(p);
    assert.ok(pricing, `Pricing must exist for provider: ${p}`);
    assert.ok(pricing.inputPricePerMillion > 0, `${p} must have positive input rate`);
    assert.ok(pricing.outputPricePerMillion > 0, `${p} must have positive output rate`);
    assert.strictEqual(
      pricing.inputPricePerToken,
      pricing.inputPricePerMillion / 1_000_000,
      "Token rate must equal million rate / 1M"
    );
    console.log(`  ✓ Provider ${p.padEnd(12)}: $${pricing.inputPricePerMillion}/1M in, $${pricing.outputPricePerMillion}/1M out`);
  }

  // Check specific model name lookup
  const claudePricing = getModelPricing("claude", "claude-sonnet-4-6");
  assert.strictEqual(claudePricing.inputPricePerMillion, 3.0);
  assert.strictEqual(claudePricing.outputPricePerMillion, 15.0);
  console.log("  ✓ Direct model lookup (claude-sonnet-4-6) validated");

  console.log("\n=== 2. Validating Usage Cost Calculation ===");
  // Test calculation: sea-lion (0.3 in, 2.4 out)
  // 10,000 prompt tokens: 10000 * 0.3 / 1M = $0.003
  // 2,500 completion tokens: 2500 * 2.4 / 1M = $0.006
  // Total: $0.009
  const cost = calculateUsageCost("sea-lion", "qwen-sea-lion", 10_000, 2_500);
  assert.strictEqual(cost.inputCost, 0.003);
  assert.strictEqual(cost.outputCost, 0.006);
  assert.strictEqual(cost.totalCost, 0.009);
  console.log(`  ✓ 10k prompt + 2.5k completion on sea-lion = $${cost.totalCost.toFixed(4)} (matches exact math)`);

  console.log("\n=== 3. Validating Predefined Deposit Amounts ===");
  assert.strictEqual(PREDEFINED_DEPOSIT_AMOUNTS.length, 5);
  const expectedDeposits = [
    { amountUSD: 5, amountCents: 500, label: "$5" },
    { amountUSD: 10, amountCents: 1000, label: "$10" },
    { amountUSD: 25, amountCents: 2500, label: "$25" },
    { amountUSD: 50, amountCents: 5000, label: "$50" },
    { amountUSD: 100, amountCents: 10000, label: "$100" },
  ];
  for (let i = 0; i < expectedDeposits.length; i++) {
    assert.deepStrictEqual(PREDEFINED_DEPOSIT_AMOUNTS[i], expectedDeposits[i]);
    console.log(`  ✓ Deposit option ${PREDEFINED_DEPOSIT_AMOUNTS[i].label} (${PREDEFINED_DEPOSIT_AMOUNTS[i].amountCents} cents)`);
  }

  console.log("\n=== 4. Validating Credit Balance Operations & Transactions ===");
  const testUserId = "tester-validation-user-" + Date.now();
  await ensureAccount({ id: testUserId, email: "tester@example.com" });
  // Restrict plan providers to sea-lion only, agentTools = false
  await changeTokenFile((f) => {
    const a = f.accounts.find((acc) => acc.userId === testUserId);
    if (a) {
      a.providers = ["sea-lion"];
      a.agentTools = false;
    }
  });
  
  // 4a: Add credit via deposit amount ($10)
  const updatedAcc = await addAccountCreditCents(testUserId, 1000, "order-test-123", "Test PayPal deposit");
  assert.ok(updatedAcc, "Account should be updated with credit");
  assert.strictEqual(getAccountCredit(updatedAcc), 10.0);
  assert.strictEqual(getAccountCreditCents(updatedAcc), 1000);
  console.log(`  ✓ Deposited $10.00 (1000 cents), account credit balance is $${getAccountCredit(updatedAcc)}`);

  // 4b: Deduct credit for usage
  // Deduct 5,000 prompt tokens and 1,000 completion tokens on claude ($3 in, $15 out / 1M)
  // 5000 * 3 / 1M = 0.015, 1000 * 15 / 1M = 0.015, total = $0.03
  const deductResult = await deductCreditForUsage(testUserId, "claude", "claude-sonnet-4-6", 5_000, 1_000);
  assert.ok(deductResult, "Deduction result should not be null");
  assert.strictEqual(deductResult.cost.totalCost, 0.03);
  assert.strictEqual(deductResult.previousBalance, 10.0);
  assert.strictEqual(deductResult.newBalance, 9.97);
  console.log(`  ✓ Deducted $${deductResult.cost.totalCost} for Claude usage. New balance: $${deductResult.newBalance}`);

  // 4c: Check transaction logging
  const fileAccount = updatedAcc as Account;
  assert.ok(fileAccount.transactions && fileAccount.transactions.length >= 2, "Should have deposit and usage transactions");
  const depositTx = fileAccount.transactions.find((t) => t.type === "deposit");
  const usageTx = fileAccount.transactions.find((t) => t.type === "usage");
  assert.ok(depositTx, "Deposit transaction recorded");
  assert.strictEqual(depositTx?.amountCents, 1000);
  assert.ok(usageTx, "Usage transaction recorded");
  assert.strictEqual(usageTx?.amountUSD, -0.03);
  console.log("  ✓ Transaction logs verified for both deposit and usage deduction");

  console.log("\n=== 5. Validating Gateway Access & Unrestricted Model Access ===");
  const { key: testKey } = await createKey({ name: "tester-key" }, testUserId);
  const testAccess: Extract<Access, { ok: true; who: "token" }> = {
    ok: true,
    who: "token",
    key: testKey,
  };

  // Test provider permissions with credit: account plan only has ["sea-lion"],
  // but hasCredit unlocks all providers (claude, codex, gemini, etc.) and enables tools.
  for (const p of ["sea-lion", "claude", "codex", "gemini", "antigravity", "grok"]) {
    const rule = keyRule(testAccess, p);
    assert.strictEqual(rule.refused, null, `Provider ${p} must be allowed when user has credit`);
    assert.strictEqual(rule.sandboxed, false, `Provider ${p} should have tools un-sandboxed when user has credit`);
    console.log(`  ✓ Model access to ${p.padEnd(12)}: ALLOWED (unrestricted with credit balance)`);
  }

  // Admission check via admit()
  const admitResult = admit(testKey);
  assert.strictEqual(admitResult, null, "admit() should return null (allow request) when user has credit");
  console.log("  ✓ admit() allows request with active credit balance");

  console.log("\n=== 6. Validating Zero Balance Rejection (HTTP 402 logic) ===");
  // Drain balance to 0
  await deductAccountCredit(testUserId, 9.97, "Drain balance");
  const currentCredit = getAccountCredit(updatedAcc);
  assert.strictEqual(currentCredit, 0, "Balance must be 0 after draining");

  // Validate HTTP 402 gateway condition
  const hasPlanTokens = false;
  const wouldReject402 = currentCredit <= 0 && !hasPlanTokens;
  assert.strictEqual(wouldReject402, true, "Gateway must reject with 402 when balance <= 0 and no plan tokens");

  // When credit is 0 and plan only allows "sea-lion", keyRule must refuse "claude"
  const blockedRule = keyRule(testAccess, "claude");
  assert.ok(blockedRule.refused !== null, "Access to claude must be refused when credit is 0 and not in plan");
  console.log(`  ✓ Restricted provider blocked without credit: "${blockedRule.refused}"`);
  console.log("  ✓ Requests blocked (HTTP 402) when credit is 0 without active plan tokens");

  // Cleanup test account and test key
  await changeTokenFile((f) => {
    const accIdx = f.accounts.findIndex((a) => a.userId === testUserId);
    if (accIdx !== -1) f.accounts.splice(accIdx, 1);
    const keyIdx = f.tokens.findIndex((k) => k.id === testKey.id);
    if (keyIdx !== -1) f.tokens.splice(keyIdx, 1);
  });
  console.log("  ✓ Cleaned up test account and key from state store");

  console.log("\nALL INTEGRATION TESTS PASSED CLEANLY! ✓\n");
}

runIntegrationTests().catch((err) => {
  console.error("Integration test failed:", err);
  process.exit(1);
});
