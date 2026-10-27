// Default token packs available for purchase in the shop / Buy tokens tab.
// Prices follow the rule: at most a tenth of the market value of the cheapest provider covered.

export type TokenPack = {
  id: string;
  name: string;
  description: string;
  tokens: number;
  providers: string[] | null;
  agentTools: boolean;
  maxKeys: number;
  perMinute: number | null;
  days: number | null;
  priceCents: number;
  active: boolean;
  createdAt: string;
  marketPriceUSD: number;
  sellingPriceUSD: number;
  savingPercent: number;
};

export const DEFAULT_PACKS: TokenPack[] = [
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B (100M tokens)",
    description: "100M tokens for GPT-OSS 120B on Groq",
    tokens: 100_000_000,
    providers: ["groq"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 120,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 26.25,
    sellingPriceUSD: 1.20,
    savingPercent: 95,
  },
  {
    id: "grok",
    name: "Grok (100M tokens)",
    description: "100M tokens for Grok",
    tokens: 100_000_000,
    providers: ["grok"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 250,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 27.50,
    sellingPriceUSD: 2.50,
    savingPercent: 91,
  },
  {
    id: "mimo",
    name: "MiMo (100M tokens)",
    description: "100M tokens for MiMo",
    tokens: 100_000_000,
    providers: ["mimo"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 250,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 54.38,
    sellingPriceUSD: 2.50,
    savingPercent: 95,
  },
  {
    id: "sea-lion",
    name: "SEA-LION (100M tokens)",
    description: "100M tokens for SEA-LION",
    tokens: 100_000_000,
    providers: ["sea-lion"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 200,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 82.50,
    sellingPriceUSD: 2.00,
    savingPercent: 98,
  },
  {
    id: "qwen-3-8",
    name: "Qwen 3.8 (100M tokens)",
    description: "100M tokens for Qwen 3.8 on Cerebras",
    tokens: 100_000_000,
    providers: ["cerebras"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 200,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 111.50,
    sellingPriceUSD: 2.00,
    savingPercent: 98,
  },
  {
    id: "gpt-5-codex-chatgpt",
    name: "GPT-5 Codex or ChatGPT (10M tokens)",
    description: "10M tokens for GPT-5 Codex or ChatGPT",
    tokens: 10_000_000,
    providers: ["codex", "chatgpt"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 120,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 34.38,
    sellingPriceUSD: 1.20,
    savingPercent: 97,
  },
  {
    id: "gemini",
    name: "Gemini (10M tokens)",
    description: "10M tokens for Gemini",
    tokens: 10_000_000,
    providers: ["gemini"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 50,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 45.00,
    sellingPriceUSD: 0.50,
    savingPercent: 99,
  },
  {
    id: "claude",
    name: "Claude (10M tokens)",
    description: "10M tokens for Claude",
    tokens: 10_000_000,
    providers: ["claude"],
    agentTools: false,
    maxKeys: 5,
    perMinute: null,
    days: null,
    priceCents: 100,
    active: true,
    createdAt: "2026-10-27T00:00:00.000Z",
    marketPriceUSD: 60.00,
    sellingPriceUSD: 1.00,
    savingPercent: 98,
  },
];
