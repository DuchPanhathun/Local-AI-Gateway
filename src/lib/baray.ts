import crypto from "node:crypto";

/**
 * Baray Gateway Client Library
 *
 * Implements:
 * - AES-256-CBC encryption and decryption with PKCS7 padding
 * - Base64 key (32 bytes) and IV (16 bytes) decoding
 * - Request payload preparation for BARAY_PAY_URL (POST /pay)
 * - Order status check via BARAY_CHECK_URL (POST /payments/check/order or /payments/check/intent)
 * - Webhook response verification and orderId decryption
 *
 * Spec reference: https://baray.io/llm.txt
 */

export class BarayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string | number,
    readonly errorType?: string
  ) {
    super(message);
    this.name = "BarayError";
  }
}

export interface BarayConfig {
  apiKey?: string;
  sk?: string;
  iv?: string;
  payUrl: string;
  checkoutBaseUrl: string;
  checkUrl: string;
  checkIntentUrl: string;
  apiBase: string;
  orgId?: string;
}

export function getBarayConfig(override?: Partial<BarayConfig>): BarayConfig {
  const apiBase = override?.apiBase || process.env.BARAY_API_BASE || "https://api.baray.io";
  const checkoutBaseUrl =
    override?.checkoutBaseUrl ||
    process.env.BARAY_CHECKOUT_BASE_URL ||
    "https://pay.baray.io";
  return {
    apiKey: override?.apiKey ?? process.env.BARAY_API_KEY,
    sk: override?.sk ?? process.env.BARAY_SK,
    iv: override?.iv ?? process.env.BARAY_IV,
    payUrl: override?.payUrl || process.env.BARAY_PAY_URL || `${apiBase}/pay`,
    checkoutBaseUrl,
    checkUrl: override?.checkUrl || process.env.BARAY_CHECK_URL || `${apiBase}/payments/check/order`,
    checkIntentUrl: override?.checkIntentUrl || process.env.BARAY_CHECK_INTENT_URL || `${apiBase}/payments/check/intent`,
    apiBase,
    orgId: override?.orgId ?? process.env.BARAY_ORG_ID,
  };
}

/**
 * Constructs the checkout URL for a given intent ID using BARAY_CHECKOUT_BASE_URL.
 */
export function getCheckoutUrl(intentId: string, override?: Partial<BarayConfig>): string {
  const config = getBarayConfig(override);
  const base = config.checkoutBaseUrl.replace(/\/+$/, "");
  return `${base}/${intentId}`;
}

export function isBarayConfigured(override?: Partial<BarayConfig>): boolean {
  const config = getBarayConfig(override);
  return Boolean(config.apiKey && config.sk && config.iv);
}

// ---------------------------------------------------------------------------
// AES-256-CBC Encryption & Decryption
// ---------------------------------------------------------------------------

export interface KeyPair {
  key: Buffer;
  iv: Buffer;
}

/**
 * Validates and decodes the base64-encoded secret key and initialization vector.
 * Key must be 32 bytes (256 bits); IV must be 16 bytes (128 bits).
 */
export function parseKeys(sk?: string, iv?: string): KeyPair {
  const secret = sk || process.env.BARAY_SK;
  const initVec = iv || process.env.BARAY_IV;

  if (!secret) {
    throw new BarayError(500, "Missing Baray secret key (BARAY_SK)", "MISSING_BARAY_SK");
  }
  if (!initVec) {
    throw new BarayError(500, "Missing Baray IV (BARAY_IV)", "MISSING_BARAY_IV");
  }

  const keyBuf = Buffer.from(secret, "base64");
  const ivBuf = Buffer.from(initVec, "base64");

  if (keyBuf.length !== 32) {
    throw new BarayError(
      500,
      `Invalid BARAY_SK length: decoded to ${keyBuf.length} bytes (expected 32 bytes for AES-256)`,
      "INVALID_KEY_LENGTH"
    );
  }
  if (ivBuf.length !== 16) {
    throw new BarayError(
      500,
      `Invalid BARAY_IV length: decoded to ${ivBuf.length} bytes (expected 16 bytes for AES-256-CBC IV)`,
      "INVALID_IV_LENGTH"
    );
  }

  return { key: keyBuf, iv: ivBuf };
}

/**
 * Encrypts a UTF-8 string with AES-256-CBC using PKCS7 padding.
 * Returns Base64-encoded ciphertext.
 */
export function encryptText(text: string, sk?: string, iv?: string): string {
  const { key, iv: ivBuf } = parseKeys(sk, iv);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, ivBuf);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

/**
 * Decrypts a Base64-encoded ciphertext with AES-256-CBC and PKCS7 padding.
 * Returns original UTF-8 string.
 */
export function decryptText(cipherBase64: string, sk?: string, iv?: string): string {
  const { key, iv: ivBuf } = parseKeys(sk, iv);
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, ivBuf);
    return Buffer.concat([
      decipher.update(Buffer.from(cipherBase64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BarayError(400, `Decryption failed: ${msg}`, "INVALID_ENCRYPTION");
  }
}

/**
 * Encrypts arbitrary payload object into Base64 AES-256-CBC ciphertext.
 */
export function encryptPayload(payload: unknown, sk?: string, iv?: string): string {
  return encryptText(JSON.stringify(payload), sk, iv);
}

/**
 * Decrypts Base64 AES-256-CBC ciphertext and parses JSON.
 */
export function decryptPayload<T = unknown>(cipherBase64: string, sk?: string, iv?: string): T {
  const text = decryptText(cipherBase64, sk, iv);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BarayError(400, "Decrypted text is not valid JSON", "INVALID_PAYLOAD_JSON");
  }
}

/**
 * Convenience helper to decrypt encrypted_order_id received in webhooks.
 */
export function decryptOrderId(encryptedOrderId: string, sk?: string, iv?: string): string {
  return decryptText(encryptedOrderId, sk, iv);
}

// ---------------------------------------------------------------------------
// Payment Payload Preparation
// ---------------------------------------------------------------------------

export type BarayCurrency = "USD" | "KHR";

export interface BarayPaymentPayload {
  amount: string; // Truncated to 2 decimal places, text format (never JSON number)
  currency: BarayCurrency;
  order_id: string;
  tracking?: Record<string, unknown>;
  order_details?: {
    items?: Array<{ name: string; price: number; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  custom_success_url?: string;
  intent_lifetime?: number; // Minutes, min 3, max 15
}

export interface PreparePaymentOptions {
  amount: number | string;
  currency?: BarayCurrency;
  orderId: string;
  tracking?: Record<string, unknown>;
  orderDetails?: {
    items?: Array<{ name: string; price: number; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  customSuccessUrl?: string;
  intentLifetime?: number; // 3 to 15 minutes
}

export interface BarayEncryptedRequest {
  data: string;
}

/**
 * Formats and truncates amount to exactly 2 decimals as required by Baray.
 */
export function formatBarayAmount(amount: number | string): string {
  const num = typeof amount === "number" ? amount : parseFloat(amount);
  if (isNaN(num) || num < 0) {
    throw new BarayError(400, `Invalid amount: ${amount}`, "INVALID_AMOUNT");
  }
  // Truncate to 2 decimal places (Baray truncates rather than rounds up)
  const truncated = Math.floor(num * 100) / 100;
  return truncated.toFixed(2);
}

/**
 * Validates payment parameters and builds the Baray payload structure.
 */
export function buildPaymentPayload(options: PreparePaymentOptions): BarayPaymentPayload {
  const currency: BarayCurrency = options.currency || "USD";
  if (currency !== "USD" && currency !== "KHR") {
    throw new BarayError(400, `Invalid currency: ${currency}. Must be USD or KHR.`, "INVALID_CURRENCY");
  }

  const formattedAmount = formatBarayAmount(options.amount);
  const numAmount = parseFloat(formattedAmount);

  if (currency === "USD" && numAmount < 0.01) {
    throw new BarayError(400, "USD amount must be greater than or equal to 0.01", "AMOUNT_BELOW_MINIMUM");
  }
  if (currency === "KHR" && numAmount < 100) {
    throw new BarayError(400, "KHR amount must be greater than or equal to 100", "AMOUNT_BELOW_MINIMUM");
  }

  if (!options.orderId || typeof options.orderId !== "string") {
    throw new BarayError(400, "orderId is required and must be a non-empty string", "INVALID_ORDER_ID");
  }

  if (options.intentLifetime !== undefined) {
    if (options.intentLifetime < 3 || options.intentLifetime > 15) {
      throw new BarayError(400, "Lifetime must be between 3 and 15 minutes", "INVALID_LIFETIME");
    }
  }

  const payload: BarayPaymentPayload = {
    amount: formattedAmount,
    currency,
    order_id: options.orderId,
  };

  if (options.tracking) {
    payload.tracking = options.tracking;
  }
  if (options.orderDetails) {
    payload.order_details = options.orderDetails;
  }
  if (options.customSuccessUrl) {
    payload.custom_success_url = options.customSuccessUrl;
  }
  if (options.intentLifetime) {
    payload.intent_lifetime = options.intentLifetime;
  }

  return payload;
}

/**
 * Prepares the payload and encrypts it ready for POST /pay (BARAY_PAY_URL).
 */
export function preparePaymentPayload(
  options: PreparePaymentOptions,
  sk?: string,
  iv?: string
): { payload: BarayPaymentPayload; body: BarayEncryptedRequest } {
  const payload = buildPaymentPayload(options);
  const data = encryptPayload(payload, sk, iv);
  return { payload, body: { data } };
}

// ---------------------------------------------------------------------------
// Intent Creation Client
// ---------------------------------------------------------------------------

export interface BarayIntentResponse {
  _id: string;
  intent_id: string;
  checkout_url: string;
  existing: boolean;
  org_id?: string;
  api_key?: string;
  order_id: string;
  amount: string;
  currency: BarayCurrency;
  target?: string;
  tracking?: Record<string, unknown> | null;
  order_details?: Record<string, unknown> | null;
  custom_success_url?: string | null;
  lifetime?: number | null;
  created_at?: unknown;
}

export async function createPaymentIntent(
  options: PreparePaymentOptions,
  overrideConfig?: Partial<BarayConfig>
): Promise<BarayIntentResponse> {
  const config = getBarayConfig(overrideConfig);
  if (!config.apiKey) {
    throw new BarayError(500, "Missing Baray API key (BARAY_API_KEY)", "MISSING_API_KEY");
  }

  const { body } = preparePaymentPayload(options, config.sk, config.iv);

  const res = await fetch(config.payUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const responseJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const errorType = (responseJson.type as string) || "BARAY_API_ERROR";
    const message =
      (responseJson.message as string) ||
      (responseJson.error as string) ||
      `Baray API request failed with status ${res.status}`;
    const code = (responseJson.code as string | number) || res.status;
    throw new BarayError(res.status, message, code, errorType);
  }

  return responseJson as unknown as BarayIntentResponse;
}

export interface BarayCheckoutSession {
  intentId: string;
  checkoutUrl: string;
  orderId: string;
  amount: string;
  currency: BarayCurrency;
  existing: boolean;
  raw: BarayIntentResponse;
}

/**
 * High-level helper to create a Baray checkout session (payment intent).
 * Resolves the canonical checkoutUrl using BARAY_CHECKOUT_BASE_URL if needed.
 */
export async function createCheckoutSession(
  options: PreparePaymentOptions,
  overrideConfig?: Partial<BarayConfig>
): Promise<BarayCheckoutSession> {
  const intent = await createPaymentIntent(options, overrideConfig);
  const config = getBarayConfig(overrideConfig);
  const intentId = intent.intent_id || intent._id;
  const baseUrl = config.checkoutBaseUrl.replace(/\/+$/, "");
  const checkoutUrl = intent.checkout_url || `${baseUrl}/${intentId}`;

  return {
    intentId,
    checkoutUrl,
    orderId: intent.order_id,
    amount: intent.amount,
    currency: intent.currency,
    existing: Boolean(intent.existing),
    raw: intent,
  };
}

// ---------------------------------------------------------------------------
// Order Status Check Client (BARAY_CHECK_URL)
// ---------------------------------------------------------------------------

export type CheckStatus =
  | "success"
  | "pending"
  | "not_found"
  | "no_attempts"
  | "rate_limited"
  | "error";

export interface BarayCheckResult {
  paid: boolean;
  status: CheckStatus;
  statusCode: number;
  message?: string;
  raw?: unknown;
}

export type CheckOrderParams = {
  orderId?: string;
  intentId?: string;
  orgId?: string;
  amount?: string;
  currency?: string;
};

/**
 * Checks payment status via Baray manual transaction check endpoints.
 * - POST /payments/check/order using { org_id, order_id }
 * - POST /payments/check/intent using { intent_id }
 * No API key is required by these endpoints according to the Baray specification.
 */
export async function checkOrderStatus(
  params: CheckOrderParams,
  overrideConfig?: Partial<BarayConfig>
): Promise<BarayCheckResult> {
  const config = getBarayConfig(overrideConfig);

  let targetUrl: string;
  let requestBody: Record<string, string>;

  if (params.intentId) {
    targetUrl = config.checkIntentUrl;
    requestBody = { intent_id: params.intentId };
  } else if (params.orderId) {
    const orgId = params.orgId || config.orgId;
    if (!orgId) {
      throw new BarayError(
        400,
        "org_id is required to check status by order_id (pass orgId or set BARAY_ORG_ID)",
        "MISSING_ORG_ID"
      );
    }
    targetUrl = config.checkUrl;
    requestBody = { org_id: orgId, order_id: params.orderId };
  } else {
    throw new BarayError(400, "Either orderId or intentId must be provided", "INVALID_CHECK_PARAMS");
  }

  const res = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    cache: "no-store",
  });

  const responseJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status === 200) {
    return {
      paid: true,
      status: "success",
      statusCode: 200,
      message: (responseJson.status as string) || "success",
      raw: responseJson,
    };
  }

  if (res.status === 422) {
    return {
      paid: false,
      status: "pending",
      statusCode: 422,
      message: "Payment not completed or not yet confirmed by bank",
      raw: responseJson,
    };
  }

  if (res.status === 400) {
    const msg = (responseJson.message as string) || "Bad request";
    const isNoAttempts = msg.toLowerCase().includes("no attempts");
    return {
      paid: false,
      status: isNoAttempts ? "no_attempts" : "not_found",
      statusCode: 400,
      message: msg,
      raw: responseJson,
    };
  }

  if (res.status === 429) {
    return {
      paid: false,
      status: "rate_limited",
      statusCode: 429,
      message: (responseJson.message as string) || "Rate limited",
      raw: responseJson,
    };
  }

  return {
    paid: false,
    status: "error",
    statusCode: res.status,
    message: (responseJson.message as string) || `Unexpected check status HTTP ${res.status}`,
    raw: responseJson,
  };
}

/**
 * Verifies payment order status with Baray. Alias for checkOrderStatus.
 */
export async function verifyOrderStatus(
  params: CheckOrderParams,
  overrideConfig?: Partial<BarayConfig>
): Promise<BarayCheckResult> {
  return checkOrderStatus(params, overrideConfig);
}

// ---------------------------------------------------------------------------
// Response & Webhook Verification
// ---------------------------------------------------------------------------

export interface BarayWebhookPayload {
  encrypted_order_id: string;
  bank: "ABA" | "ACLEDA" | "SPNB" | "WING" | string;
  payment_option?: string;
  event_id: string;
  occurred_at: number;
}

export interface VerifiedBarayWebhook {
  orderId: string;
  bank: string;
  paymentOption?: string;
  eventId: string;
  occurredAt: number;
}

/**
 * Validates and decrypts an incoming Baray webhook.
 * Decrypts encrypted_order_id with BARAY_SK and BARAY_IV.
 */
export function verifyWebhook(
  payload: unknown,
  sk?: string,
  iv?: string
): VerifiedBarayWebhook {
  if (!payload || typeof payload !== "object") {
    throw new BarayError(400, "Webhook payload must be a JSON object", "INVALID_WEBHOOK_BODY");
  }

  const data = payload as Record<string, unknown>;

  if (typeof data.encrypted_order_id !== "string" || !data.encrypted_order_id) {
    throw new BarayError(400, "Webhook missing encrypted_order_id", "MISSING_ENCRYPTED_ORDER_ID");
  }
  if (typeof data.bank !== "string" || !data.bank) {
    throw new BarayError(400, "Webhook missing bank field", "MISSING_BANK");
  }
  if (typeof data.event_id !== "string" || !data.event_id) {
    throw new BarayError(400, "Webhook missing event_id", "MISSING_EVENT_ID");
  }
  if (typeof data.occurred_at !== "number") {
    throw new BarayError(400, "Webhook missing or invalid occurred_at", "MISSING_OCCURRED_AT");
  }

  const orderId = decryptOrderId(data.encrypted_order_id, sk, iv);

  if (!orderId || typeof orderId !== "string") {
    throw new BarayError(400, "Decrypted orderId is empty", "INVALID_DECRYPTED_ORDER_ID");
  }

  return {
    orderId,
    bank: data.bank,
    paymentOption: typeof data.payment_option === "string" ? data.payment_option : undefined,
    eventId: data.event_id,
    occurredAt: data.occurred_at,
  };
}
