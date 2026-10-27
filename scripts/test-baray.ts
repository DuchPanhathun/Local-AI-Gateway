import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  BarayError,
  parseKeys,
  encryptText,
  decryptText,
  encryptPayload,
  decryptPayload,
  decryptOrderId,
  formatBarayAmount,
  buildPaymentPayload,
  preparePaymentPayload,
  createPaymentIntent,
  createCheckoutSession,
  checkOrderStatus,
  verifyOrderStatus,
  getCheckoutUrl,
  verifyWebhook,
  getBarayConfig,
  isBarayConfigured,
} from "../src/lib/baray";

// Generate valid test keys (32-byte AES key and 16-byte IV)
const TEST_KEY_BYTES = crypto.randomBytes(32);
const TEST_IV_BYTES = crypto.randomBytes(16);
const TEST_SK = TEST_KEY_BYTES.toString("base64");
const TEST_IV = TEST_IV_BYTES.toString("base64");
const TEST_API_KEY = "pk_dev_0192b5c8-7e1a-7c3d-9a4b-5e6f7a8b9c0d";
const TEST_ORG_ID = "org-0123456789abcdef01234567";

async function runTests() {
  console.log("=== 1. AES-256-CBC Key Parsing and Validation ===");
  {
    // Test configuration helpers
    const config = getBarayConfig({
      apiKey: TEST_API_KEY,
      sk: TEST_SK,
      iv: TEST_IV,
    });
    assert.strictEqual(config.apiKey, TEST_API_KEY);
    assert.strictEqual(isBarayConfigured({ apiKey: TEST_API_KEY, sk: TEST_SK, iv: TEST_IV }), true);
    assert.strictEqual(isBarayConfigured({ apiKey: undefined, sk: TEST_SK, iv: TEST_IV }), false);
    console.log("  ✓ Configuration helpers validated");

    const keys = parseKeys(TEST_SK, TEST_IV);
    assert.strictEqual(keys.key.length, 32, "Decoded secret key must be 32 bytes");
    assert.strictEqual(keys.iv.length, 16, "Decoded IV must be 16 bytes");
    assert.deepStrictEqual(keys.key, TEST_KEY_BYTES);
    assert.deepStrictEqual(keys.iv, TEST_IV_BYTES);
    console.log("  ✓ Valid Base64 32-byte key and 16-byte IV parsed successfully");

    // Invalid key length (e.g. 16 bytes instead of 32)
    const invalidKey = Buffer.alloc(16).toString("base64");
    assert.throws(
      () => parseKeys(invalidKey, TEST_IV),
      (err: unknown) => err instanceof BarayError && err.code === "INVALID_KEY_LENGTH",
      "Should reject non-32-byte key"
    );
    console.log("  ✓ Correctly rejected invalid key length");

    // Invalid IV length (e.g. 8 bytes instead of 16)
    const invalidIv = Buffer.alloc(8).toString("base64");
    assert.throws(
      () => parseKeys(TEST_SK, invalidIv),
      (err: unknown) => err instanceof BarayError && err.code === "INVALID_IV_LENGTH",
      "Should reject non-16-byte IV"
    );
    console.log("  ✓ Correctly rejected invalid IV length");
  }

  console.log("\n=== 2. AES-256-CBC Encryption & Decryption ===");
  {
    // Plain text encryption and decryption
    const plainText = "ORDER-TEST-12345-PAYMENT";
    const encrypted = encryptText(plainText, TEST_SK, TEST_IV);
    assert.notStrictEqual(encrypted, plainText);
    assert.ok(typeof encrypted === "string" && encrypted.length > 0);

    const decrypted = decryptText(encrypted, TEST_SK, TEST_IV);
    assert.strictEqual(decrypted, plainText, "Decrypted text must match original plain text");
    console.log("  ✓ String encrypt/decrypt round-trip validated");

    // Payload object encryption and decryption
    const payload = {
      amount: "15.50",
      currency: "USD",
      order_id: "ORD-999",
      tracking: { customer_id: "user_42" },
    };
    const encryptedPayload = encryptPayload(payload, TEST_SK, TEST_IV);
    const decryptedPayload = decryptPayload<typeof payload>(encryptedPayload, TEST_SK, TEST_IV);
    assert.deepStrictEqual(decryptedPayload, payload);
    console.log("  ✓ JSON payload encrypt/decrypt round-trip validated");

    // Order ID decryption helper (used in webhooks)
    const decryptedOrderId = decryptOrderId(encrypted, TEST_SK, TEST_IV);
    assert.strictEqual(decryptedOrderId, plainText);
    console.log("  ✓ decryptOrderId helper validated");

    // Decryption failure on corrupted ciphertext
    assert.throws(
      () => decryptText("invalid-base64-ciphertext!!!", TEST_SK, TEST_IV),
      (err: unknown) => err instanceof BarayError && err.status === 400,
      "Should throw BarayError on invalid ciphertext"
    );
    console.log("  ✓ Decryption failure handled gracefully");
  }

  console.log("\n=== 3. Payload Preparation for BARAY_PAY_URL ===");
  {
    // Amount formatting & truncation
    assert.strictEqual(formatBarayAmount(10), "10.00");
    assert.strictEqual(formatBarayAmount(10.5), "10.50");
    assert.strictEqual(formatBarayAmount(10.999), "10.99", "Baray truncates without rounding up");
    assert.strictEqual(formatBarayAmount("25.00"), "25.00");
    console.log("  ✓ Amount formatting and truncation validated");

    // Build payload validation
    const valid = buildPaymentPayload({
      amount: 25,
      currency: "USD",
      orderId: "ORDER-DEPOSIT-25",
      tracking: { userId: "user_1" },
      intentLifetime: 10,
    });
    assert.strictEqual(valid.amount, "25.00");
    assert.strictEqual(valid.currency, "USD");
    assert.strictEqual(valid.order_id, "ORDER-DEPOSIT-25");
    assert.strictEqual(valid.intent_lifetime, 10);
    console.log("  ✓ buildPaymentPayload constructs valid structure");

    // USD minimum validation (< 0.01 rejected)
    assert.throws(
      () => buildPaymentPayload({ amount: 0.005, currency: "USD", orderId: "ORD-1" }),
      (err: unknown) => err instanceof BarayError && err.code === "AMOUNT_BELOW_MINIMUM"
    );
    console.log("  ✓ USD minimum validation ($0.01) enforced");

    // KHR minimum validation (< 100 rejected)
    assert.throws(
      () => buildPaymentPayload({ amount: 99, currency: "KHR", orderId: "ORD-2" }),
      (err: unknown) => err instanceof BarayError && err.code === "AMOUNT_BELOW_MINIMUM"
    );
    console.log("  ✓ KHR minimum validation (100 KHR) enforced");

    // Lifetime bounds (3 <= lifetime <= 15)
    assert.throws(
      () => buildPaymentPayload({ amount: 10, orderId: "ORD-3", intentLifetime: 2 }),
      (err: unknown) => err instanceof BarayError && err.code === "INVALID_LIFETIME"
    );
    assert.throws(
      () => buildPaymentPayload({ amount: 10, orderId: "ORD-4", intentLifetime: 16 }),
      (err: unknown) => err instanceof BarayError && err.code === "INVALID_LIFETIME"
    );
    console.log("  ✓ Lifetime bounds (3-15 min) enforced");

    // Payload preparation and encrypted body
    const prepared = preparePaymentPayload(
      {
        amount: 50.0,
        currency: "USD",
        orderId: "ORDER-50",
      },
      TEST_SK,
      TEST_IV
    );
    assert.ok(prepared.body.data, "Must contain encrypted data string");
    const decrypted = decryptPayload<Record<string, unknown>>(prepared.body.data, TEST_SK, TEST_IV);
    assert.strictEqual(decrypted.order_id, "ORDER-50");
    assert.strictEqual(decrypted.amount, "50.00");
    console.log("  ✓ preparePaymentPayload generates encrypted request body for BARAY_PAY_URL");
  }

  console.log("\n=== 4. Webhook Response Verification ===");
  {
    const originalOrderId = "ORDER-DEPOSIT-100-ABC";
    const encryptedOrderId = encryptText(originalOrderId, TEST_SK, TEST_IV);

    const webhookPayload = {
      encrypted_order_id: encryptedOrderId,
      bank: "ABA",
      payment_option: "ABAPAY_KHQR",
      event_id: "evt-tx-itn-test-123456",
      occurred_at: Math.floor(Date.now() / 1000),
    };

    const verified = verifyWebhook(webhookPayload, TEST_SK, TEST_IV);
    assert.strictEqual(verified.orderId, originalOrderId);
    assert.strictEqual(verified.bank, "ABA");
    assert.strictEqual(verified.paymentOption, "ABAPAY_KHQR");
    assert.strictEqual(verified.eventId, "evt-tx-itn-test-123456");
    console.log("  ✓ Webhook verified and decrypted orderId successfully");

    // Webhook with corrupted encrypted_order_id
    assert.throws(
      () => verifyWebhook({ ...webhookPayload, encrypted_order_id: "tampered_ciphertext" }, TEST_SK, TEST_IV),
      (err: unknown) => err instanceof BarayError
    );
    console.log("  ✓ Tampered webhook correctly rejected");

    // Webhook missing required fields
    assert.throws(
      () => verifyWebhook({ bank: "ABA", event_id: "evt-1" }, TEST_SK, TEST_IV),
      (err: unknown) => err instanceof BarayError && err.code === "MISSING_ENCRYPTED_ORDER_ID"
    );
    console.log("  ✓ Missing fields validation enforced");
  }

  console.log("\n=== 5. Client Methods & HTTP Mock Integration ===");
  {
    const originalFetch = globalThis.fetch;
    try {
      // Mock POST /pay (createPaymentIntent)
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = init?.headers as Record<string, string>;
        assert.strictEqual(headers["x-api-key"], TEST_API_KEY, "x-api-key header must be sent");
        assert.strictEqual(headers["Content-Type"], "application/json");

        const body = JSON.parse(init?.body as string);
        assert.ok(body.data, "Request body must contain encrypted 'data'");

        // Decrypt and verify payload
        const decrypted = decryptPayload<Record<string, unknown>>(body.data, TEST_SK, TEST_IV);
        assert.strictEqual(decrypted.order_id, "ORDER-MOCK-1");

        return new Response(
          JSON.stringify({
            _id: "itn-0123456789abcdef0123456789abcdef",
            intent_id: "itn-0123456789abcdef0123456789abcdef",
            checkout_url: "https://pay.baray.io/itn-0123456789abcdef0123456789abcdef",
            existing: false,
            order_id: decrypted.order_id,
            amount: decrypted.amount,
            currency: decrypted.currency,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const intent = await createPaymentIntent(
        {
          amount: 25.0,
          currency: "USD",
          orderId: "ORDER-MOCK-1",
        },
        {
          apiKey: TEST_API_KEY,
          sk: TEST_SK,
          iv: TEST_IV,
          payUrl: "https://api.baray.io/pay",
        }
      );

      assert.strictEqual(intent.intent_id, "itn-0123456789abcdef0123456789abcdef");
      assert.strictEqual(intent.checkout_url, "https://pay.baray.io/itn-0123456789abcdef0123456789abcdef");
      assert.strictEqual(intent.order_id, "ORDER-MOCK-1");
      console.log("  ✓ createPaymentIntent sent encrypted request and parsed intent response");

      // Mock checkOrderStatus (200 success)
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ status: "success" }), { status: 200 });
      };

      const checkSuccess = await checkOrderStatus(
        { orderId: "ORDER-MOCK-1", orgId: TEST_ORG_ID },
        { checkUrl: "https://api.baray.io/payments/check/order" }
      );
      assert.strictEqual(checkSuccess.paid, true);
      assert.strictEqual(checkSuccess.status, "success");
      console.log("  ✓ checkOrderStatus (200 success) verified");

      // Mock checkOrderStatus (422 pending)
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({}), { status: 422 });
      };

      const checkPending = await checkOrderStatus(
        { intentId: "itn-12345" },
        { checkIntentUrl: "https://api.baray.io/payments/check/intent" }
      );
      assert.strictEqual(checkPending.paid, false);
      assert.strictEqual(checkPending.status, "pending");
      console.log("  ✓ checkOrderStatus (422 pending) verified");

      // Mock checkOrderStatus (400 not found)
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ code: 400, message: "Intent not found" }), { status: 400 });
      };

      const checkNotFound = await checkOrderStatus(
        { intentId: "itn-unknown" },
        { checkIntentUrl: "https://api.baray.io/payments/check/intent" }
      );
      assert.strictEqual(checkNotFound.paid, false);
      assert.strictEqual(checkNotFound.status, "not_found");
      console.log("  ✓ checkOrderStatus (400 not found) verified");

      // Mock checkOrderStatus (429 rate limited)
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ code: 429, message: "Too many requests" }), { status: 429 });
      };

      const checkRateLimited = await checkOrderStatus(
        { intentId: "itn-ratelimit" },
        { checkIntentUrl: "https://api.baray.io/payments/check/intent" }
      );
      assert.strictEqual(checkRateLimited.paid, false);
      assert.strictEqual(checkRateLimited.status, "rate_limited");
      console.log("  ✓ checkOrderStatus (429 rate limit) verified");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("\n=== ALL BARAY GATEWAY UNIT TESTS PASSED ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});