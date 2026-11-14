
// Model pricing rates for pay-as-you-go credit deduction.
// Rates are defined in USD per million tokens (input and output),
// matching market rates and provider specifications.

export type ModelRate = {
  provider: string;
  model: string;
  inputPricePerMillion: number; // USD per 1,000,000 tokens
  outputPricePerMillion: number; // USD per 1,000,000 tokens
  inputPricePerToken: number;
  outputPricePerToken: number;
};

export const MODEL_PRICING_RATES: Record<string, { model: string; input: number; output: number }> = {
  // Cloud providers
  "sea-lion": { model: "Qwen-SEA-LION v4.5 27B", input: 0.3, output: 2.4 },
  "aisingapore/qwen-sea-lion-v4.5-27b-it": { model: "Qwen-SEA-LION v4.5 27B", input: 0.3, output: 2.4 },
  "qwen-sea-lion": { model: "Qwen-SEA-LION v4.5 27B", input: 0.3, output: 2.4 },

  cerebras: { model: "Qwen 3.8 27B", input: 0.99, output: 1.49 },
  "qwen-3.8-27b": { model: "Qwen 3.8 27B", input: 0.99, output: 1.49 },
  "llama-3.3-70b": { model: "Llama 3.3 70B", input: 0.99, output: 1.49 },
  "llama3.1-8b": { model: "Llama 3.1 8B", input: 0.1, output: 0.1 },

  groq: { model: "GPT-OSS 120B", input: 0.15, output: 0.6 },
  "openai/gpt-oss-120b": { model: "GPT-OSS 120B", input: 0.15, output: 0.6 },
  "gpt-oss-120b": { model: "GPT-OSS 120B", input: 0.15, output: 0.6 },
  "llama-3.3-70b-versatile": { model: "Llama 3.3 70B Versatile", input: 0.59, output: 0.79 },

  // Coarena serves many models. Its own rate is its default model's, Claude Fable 5.2;
  // the Claude ids it serves get their own rows (Anthropic's list prices, per
  // platform.claude.com/docs/en/about-claude/pricing, Nov 2026), or the "claude"
  // row below would match them by substring and charge Sonnet 4.6 rates. Its other
  // models (Gemini, Grok, Kimi, ...) have no row yet and fall back to the provider rate.
  coarena: { model: "Claude Fable 5.2", input: 8, output: 40 },
  "claude-fable-5-2": { model: "Claude Fable 5.2", input: 8, output: 40 },
  "claude-fable-5-1": { model: "Claude Fable 5.1", input: 10, output: 50 },
  "claude-fable-5": { model: "Claude Fable 5", input: 10, output: 50 },
  "claude-opus-5-5": { model: "Claude Opus 5.5", input: 4, output: 20 },
  "claude-sonnet-5-5": { model: "Claude Sonnet 5.5", input: 2, output: 10 },
  "claude-haiku-5-5": { model: "Claude Haiku 5.5", input: 0.1, output: 0.5 }, // prompts up to 100K tokens

  // Google AI Studio. Its own rate is its default model's, Gemini 3.5 Flash-Lite. The free tier costs the gateway
  // nothing; these are Google's paid-tier list prices (aistudio.google.com/docs/pricing, 2026-11-14), so a customer
  // pays what the model costs elsewhere. Every id it serves has a row, or "gemini" below would match it by substring
  // and charge Gemini 3 Pro rates. Not verbatim on the page, from a summary of it: 3.1 Flash-Lite, 3 Flash,
  // Robotics-ER 2 and the embeddings. Changing on 2027-01-01: 3.6 Flash and 3.8 Flash to 1.50 / 7.50,
  // Robotics-ER 2 to 2 / 10. Speech and transcription are counted in requests, not tokens, as MiMo's are.
  google: { model: "Gemini 3.5 Flash-Lite", input: 0.3, output: 2.5 },
  "gemini-3.5-flash-lite": { model: "Gemini 3.5 Flash-Lite", input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { model: "Gemini 3.1 Flash-Lite", input: 0.25, output: 1.5 },
  "gemini-3-flash-preview": { model: "Gemini 3 Flash (preview)", input: 0.5, output: 3 },
  "gemini-3.6-flash": { model: "Gemini 3.6 Flash", input: 0.75, output: 3.75 },
  "gemini-3.8-flash": { model: "Gemini 3.8 Flash", input: 0.75, output: 3.75 },
  "gemini-4-hydrogen": { model: "Gemini 4 Hydrogen", input: 1.5, output: 7.5 },
  "gemini-robotics-er-2-preview": { model: "Gemini Robotics-ER 2 (preview)", input: 1, output: 5 },
  "gemini-embedding-001": { model: "Gemini Embedding 1", input: 0.15, output: 0 },
  "gemini-embedding-2": { model: "Gemini Embedding 2", input: 0.2, output: 0 },

  // Local agent / Web chat providers
  claude: { model: "Claude Sonnet 4.6", input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { model: "Claude Sonnet 4.6", input: 3.0, output: 15.0 },
  "claude-3-5-sonnet": { model: "Claude Sonnet 3.5", input: 3.0, output: 15.0 },

  codex: { model: "GPT-5 Codex", input: 1.25, output: 10.0 },
  "gpt-5-codex": { model: "GPT-5 Codex", input: 1.25, output: 10.0 },

  gemini: { model: "Gemini 3 Pro", input: 2.0, output: 12.0 },
  "gemini-3-pro": { model: "Gemini 3 Pro", input: 2.0, output: 12.0 },

  antigravity: { model: "Gemini 3 Pro (Antigravity)", input: 2.0, output: 12.0 },

  chatgpt: { model: "GPT-5 (ChatGPT)", input: 1.25, output: 10.0 },
  "gpt-5": { model: "GPT-5 (ChatGPT)", input: 1.25, output: 10.0 },

  grok: { model: "Grok 4.1 Fast", input: 0.2, output: 0.5 },
  "grok-4-1-fast": { model: "Grok 4.1 Fast", input: 0.2, output: 0.5 },

  mimo: { model: "MiMo-V2.6 Pro", input: 0.435, output: 0.87 },
  "mimo-v2.6-pro": { model: "MiMo-V2.6 Pro", input: 0.435, output: 0.87 },
};

export function getModelPricing(provider: string, modelName?: string): ModelRate {
  const pLower = (provider || "").toLowerCase().trim();
  const mLower = (modelName || "").toLowerCase().trim();

  // 1. Check direct model match
  if (mLower && MODEL_PRICING_RATES[mLower]) {
    const rateDef = MODEL_PRICING_RATES[mLower];
    return {
      provider: pLower || rateDef.model,
      model: modelName || rateDef.model,
      inputPricePerMillion: rateDef.input,
      outputPricePerMillion: rateDef.output,
      inputPricePerToken: rateDef.input / 1_000_000,
      outputPricePerToken: rateDef.output / 1_000_000,
    };
  }

  // 2. Check direct provider match
  if (pLower && MODEL_PRICING_RATES[pLower]) {
    const rateDef = MODEL_PRICING_RATES[pLower];
    return {
      provider: pLower,
      model: modelName || rateDef.model,
      inputPricePerMillion: rateDef.input,
      outputPricePerMillion: rateDef.output,
      inputPricePerToken: rateDef.input / 1_000_000,
      outputPricePerToken: rateDef.output / 1_000_000,
    };
  }

  // 3. Substring match
  for (const [key, rateDef] of Object.entries(MODEL_PRICING_RATES)) {
    if (
      (mLower && (mLower.includes(key) || key.includes(mLower))) ||
      (pLower && (pLower.includes(key) || key.includes(pLower)))
    ) {
      return {
        provider: pLower || key,
        model: modelName || rateDef.model,
        inputPricePerMillion: rateDef.input,
        outputPricePerMillion: rateDef.output,
        inputPricePerToken: rateDef.input / 1_000_000,
        outputPricePerToken: rateDef.output / 1_000_000,
      };
    }
  }

  // 4. Default fallback
  const fallback = MODEL_PRICING_RATES["groq"];
  return {
    provider: pLower || "unknown",
    model: modelName || fallback.model,
    inputPricePerMillion: fallback.input,
    outputPricePerMillion: fallback.output,
    inputPricePerToken: fallback.input / 1_000_000,
    outputPricePerToken: fallback.output / 1_000_000,
  };
}

export type UsageCost = {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  rate: ModelRate;
};

export function calculateUsageCost(
  provider: string,
  modelName: string | undefined,
  inputTokens: number,
  outputTokens: number
): UsageCost {
  const rate = getModelPricing(provider, modelName);
  const inputCost = (inputTokens * rate.inputPricePerMillion) / 1_000_000;
  const outputCost = (outputTokens * rate.outputPricePerMillion) / 1_000_000;
  const totalCost = Number((inputCost + outputCost).toFixed(8));

  return {
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost,
    rate,
  };
}
