import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import {
  changeTokenFile,
  ensureAccount,
  readTokenFile,
} from "../src/lib/api-tokens";
import {
  finishOrder,
  ordersOf,
  paymentsStatus,
  ShopError,
  startBarayDepositOrder,
  startDepositOrder,
  startOrder,
} from "../src/lib/shop";
import { POST, PATCH } from "../src/app/api/account/orders/route";

// Generate mock Baray credentials for testing
const TEST_KEY_BYTES = crypto.randomBytes(32);
const TEST_IV_BYTES = crypto.randomBytes(16);
const TEST_SK = TEST_KEY_BYTES.toString("base64");
const TEST_IV = TEST_IV_BYTES.toString("base64");
const TEST_API_KEY = "pk_dev_test_baray_shop";
const TEST_ORG_ID = "org_test_shop_123";

process.env.BARAY_SK = TEST_SK;
process.env.BARAY_IV = TEST_IV;
process.env.BARAY_API_KEY = TEST_API_KEY;
process.env.BARAY_ORG_ID = TEST_ORG_ID;

async function runBarayShopTests() {
  console.log("=== 1. Validating paymentsStatus() with Baray ===");
  const status = paymentsStatus();
  assert.strictEqual(status.baray.configured, true, "Baray must be configured");
  assert.strictEqual(status.gateways.baray, true, "Gateways.baray must be true");
  assert.strictEqual(status.configured, true, "Status configured must be true when Baray is set up");
  console.log("  ✓ paymentsStatus() correctly reports Baray configured");

  const testUser = {
    id: `test-integrator-${Date.now()}`,
    email: "integrator-test@example.com",
  };

  console.log("\n=== 2. Mocking Baray HTTP Endpoints ===");
  const originalFetch = globalThis.fetch;
  let lastCreatedOrderId = "";
  let checkStatusResponse: { status: string; code?: number; message?: string } = {
    status: "success",
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    // Supabase auth mock
    if (url.includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: testUser.id, email: testUser.email }), { status: 200 });
    }

    // POST /payments/check mock (check this before /pay because /payments contains /pay)
    if (url.includes("/payments/check")) {
      if (checkStatusResponse.status === "success") {
        return new Response(JSON.stringify({ status: "success" }), { status: 200 });
      }
      if (checkStatusResponse.status === "pending") {
        return new Response(JSON.stringify({}), { status: 422 });
      }
      return new Response(
        JSON.stringify({ code: checkStatusResponse.code || 400, message: checkStatusResponse.message || "Not found" }),
        { status: 400 }
      );
    }

    // POST /pay mock
    if (url.endsWith("/pay")) {
      const body = JSON.parse(init?.body as string);
      assert.ok(body.data, "Baray /pay request body must contain encrypted 'data'");
      const mockIntentId = `itn_${crypto.randomBytes(8).toString("hex")}`;
      return new Response(
        JSON.stringify({
          _id: mockIntentId,
          intent_id: mockIntentId,
          checkout_url: `https://pay.baray.io/${mockIntentId}`,
          existing: false,
          order_id: lastCreatedOrderId,
          amount: "25.00",
          currency: "USD",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return originalFetch(input, init);
  };

  try {
    await ensureAccount(testUser);

    console.log("\n=== 3. Testing startDepositOrder with gateway = 'baray' ===");
    // Deposit $25.00 (2500 cents)
    const deposit = await startDepositOrder(testUser, 2500, "http://localhost:3000", "baray");
    assert.ok(deposit.orderId.startsWith("baray-"), "Order ID must start with baray-");
    assert.ok(deposit.approveUrl.startsWith("https://pay.baray.io/"), "Approve URL must be Baray checkout");
    lastCreatedOrderId = deposit.orderId;
    console.log(`  ✓ Created Baray deposit order: ${deposit.orderId} -> ${deposit.approveUrl}`);

    // Verify order was saved in token file
    const file = await readTokenFile();
    const savedOrder = file.shop?.orders.find((o) => o.id === deposit.orderId);
    assert.ok(savedOrder, "Order must be saved in tokens.json");
    assert.strictEqual(savedOrder?.gateway, "baray");
    assert.strictEqual(savedOrder?.type, "deposit");
    assert.strictEqual(savedOrder?.priceCents, 2500);
    assert.strictEqual(savedOrder?.creditCents, 2500);
    assert.strictEqual(savedOrder?.status, "created");
    assert.ok(savedOrder?.captureId, "captureId should hold intentId");
    console.log("  ✓ Order verified in tokens.json with status 'created'");

    console.log("\n=== 4. Testing startBarayDepositOrder convenience wrapper ===");
    const directBaray = await startBarayDepositOrder(testUser, 1000, "http://localhost:3000");
    assert.ok(directBaray.orderId.startsWith("baray-"));
    assert.ok(directBaray.approveUrl.startsWith("https://pay.baray.io/"));
    console.log("  ✓ startBarayDepositOrder works seamlessly");

    console.log("\n=== 5. Testing finishOrder (pending payment failure handling) ===");
    checkStatusResponse = { status: "pending" };
    try {
      await finishOrder(testUser, deposit.orderId);
      assert.fail("Should have thrown");
    } catch (error) {
      const err = error as ShopError;
      console.log("  -> Caught err:", err?.constructor?.name, "status:", err?.status, "message:", err?.message);
      assert.strictEqual(err instanceof ShopError, true, "Must be ShopError");
      assert.strictEqual(err.status, 402, "Status must be 402");
    }
    console.log("  ✓ Correctly rejected unconfirmed Baray order with HTTP 402");

    console.log("\n=== 6. Testing finishOrder (successful payment completion) ===");
    checkStatusResponse = { status: "success" };
    const finished = await finishOrder(testUser, deposit.orderId);
    assert.strictEqual(finished.status, "paid");
    assert.ok(finished.paidAt, "paidAt must be set");
    assert.strictEqual(finished.gateway, "baray");
    assert.ok(finished.applied?.includes("Added $25.00 to your credit balance via Baray"));
    console.log(`  ✓ Order finished successfully: status = ${finished.status}, applied = "${finished.applied}"`);

    // Verify user balance was credited
    const fileAfter = await readTokenFile();
    const userAccount = fileAfter.accounts.find((a) => a.userId === testUser.id);
    assert.strictEqual(userAccount?.balance, 25.0, "Balance must be 25.0");
    assert.strictEqual(userAccount?.creditBalance, 25.0, "Credit balance must be 25.0");
    assert.strictEqual(userAccount?.creditBalanceCents, 2500, "Credit balance cents must be 2500");
    const depositTx = userAccount?.transactions?.find((t) => t.orderId === deposit.orderId);
    assert.ok(depositTx, "Deposit transaction must be logged");
    assert.strictEqual(depositTx?.amountCents, 2500);
    assert.strictEqual(depositTx?.amountUSD, 25.0);
    assert.strictEqual(depositTx?.balanceAfterCents, 2500);
    console.log("  ✓ User balance and credit transactions verified in account");

    console.log("\n=== 7. Testing idempotency of finishOrder ===");
    const repeatedFinish = await finishOrder(testUser, deposit.orderId);
    assert.strictEqual(repeatedFinish.status, "paid");
    const fileAfterRepeat = await readTokenFile();
    const userAccountAfterRepeat = fileAfterRepeat.accounts.find((a) => a.userId === testUser.id);
    assert.strictEqual(userAccountAfterRepeat?.balance, 25.0, "Balance must not be double-credited");
    console.log("  ✓ finishOrder is idempotent: no double crediting");

    console.log("\n=== 8. Testing ordersOf() gateway mapping ===");
    const orders = await ordersOf(testUser.id);
    const barayOrder = orders.find((o) => o.id === deposit.orderId);
    assert.ok(barayOrder, "Order must be listed in ordersOf");
    assert.strictEqual(barayOrder?.gateway, "baray");
    assert.strictEqual(barayOrder?.type, "deposit");
    assert.strictEqual(barayOrder?.priceCents, 2500);
    assert.strictEqual(barayOrder?.creditCents, 2500);
    console.log("  ✓ ordersOf returns gateway and creditCents correctly");

    console.log("\n=== 9. Testing startOrder (Token Pack with Baray) ===");
    const packOrder = await startOrder(testUser, "gpt-oss-120b", "http://localhost:3000", "baray");
    assert.ok(packOrder.orderId.startsWith("baray-"));
    const filePacks = await readTokenFile();
    const savedPackOrder = filePacks.shop?.orders.find((o) => o.id === packOrder.orderId);
    assert.strictEqual(savedPackOrder?.gateway, "baray");
    assert.strictEqual(savedPackOrder?.type, "pack");
    console.log("  ✓ Token pack purchase also supports gateway = 'baray'");

    console.log("\n=== 10. Testing Next.js API Routes (POST & PATCH) ===");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-supabase.example.com";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_mock_key";

    // Test POST invalid gateway
    const reqInvalidGateway = new NextRequest("http://localhost:3000/api/account/orders", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body: JSON.stringify({ amountUSD: 50, gateway: "invalid_gw" }),
    });
    const resInvalid = await POST(reqInvalidGateway);
    assert.strictEqual(resInvalid.status, 400);
    const jsonInvalid = await resInvalid.json();
    assert.ok(jsonInvalid.error.includes("Invalid gateway"));
    console.log("  ✓ POST with invalid gateway returned 400: ", jsonInvalid.error);

    // Test POST deposit with gateway = 'baray'
    const reqDeposit = new NextRequest("http://localhost:3000/api/account/orders", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body: JSON.stringify({ amountUSD: 50, gateway: "baray" }),
    });
    const resDeposit = await POST(reqDeposit);
    assert.strictEqual(resDeposit.status, 200);
    const jsonDeposit = await resDeposit.json();
    assert.ok(jsonDeposit.orderId.startsWith("baray-"));
    assert.ok(jsonDeposit.approveUrl.startsWith("https://pay.baray.io/"));
    console.log(`  ✓ POST /api/account/orders with gateway: 'baray' returned order ${jsonDeposit.orderId}`);

    // Test PATCH ?id=... with action: 'finish'
    checkStatusResponse = { status: "success" };
    const reqFinish = new NextRequest(`http://localhost:3000/api/account/orders?id=${jsonDeposit.orderId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "finish" }),
    });
    const resFinish = await PATCH(reqFinish);
    assert.strictEqual(resFinish.status, 200);
    const jsonFinish = await resFinish.json();
    assert.strictEqual(jsonFinish.status, "paid");
    assert.strictEqual(jsonFinish.gateway, "baray");
    assert.strictEqual(jsonFinish.creditCents, 5000);
    console.log(`  ✓ PATCH /api/account/orders action: 'finish' finished Baray order: gateway=${jsonFinish.gateway}, creditCents=${jsonFinish.creditCents}`);

    console.log("\n=== 11. Cleaning up test data ===");
    await changeTokenFile((f) => {
      const accIdx = f.accounts.findIndex((a) => a.userId === testUser.id);
      if (accIdx !== -1) f.accounts.splice(accIdx, 1);
      if (f.shop?.orders) {
        f.shop.orders = f.shop.orders.filter((o) => o.userId !== testUser.id);
      }
    });
    console.log("  ✓ Test account and orders cleaned up");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\nALL BARAY SHOP INTEGRATION TESTS PASSED CLEANLY! ✓\n");
}

runBarayShopTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
