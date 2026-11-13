// Every provider the gateway can answer with, and its name in the console.

export const CLOUD_PROVIDERS = ["sea-lion", "cerebras", "groq", "coarena"] as const;
// chatgpt, grok and mimo aren't CLIs: chatgpt-web-gateway answers through their
// websites in a signed-in Chrome window. It speaks local-agent-gateway's API, so
// they're listed and called like the CLIs.
export const LOCAL_PROVIDERS = ["claude", "codex", "gemini", "antigravity", "chatgpt", "grok", "mimo"] as const;
export type ChatProvider =
  | (typeof CLOUD_PROVIDERS)[number]
  | (typeof LOCAL_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ChatProvider, string> = {
  "sea-lion": "SEA-LION",
  cerebras: "Cerebras",
  groq: "Groq",
  coarena: "Coarena",
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  chatgpt: "ChatGPT (web)",
  grok: "Grok (web)",
  mimo: "MiMo (web)",
};

// What customers see each provider as, on their account page: the model
// behind it, not how the gateway reaches it.
export const MODEL_NAMES: Record<ChatProvider, string> = {
  "sea-lion": "SEA-LION",
  cerebras: "Qwen 3.8",
  groq: "GPT-OSS 120B",
  coarena: "Claude Fable 5.2",
  claude: "Claude",
  codex: "GPT-5 Codex",
  gemini: "Gemini",
  antigravity: "Gemini 3 Pro",
  chatgpt: "ChatGPT",
  grok: "Grok",
  mimo: "MiMo",
};

// For the key and account forms' provider pickers.
export const PROVIDER_OPTIONS = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS].map((p) => ({
  id: p,
  label: PROVIDER_LABELS[p],
}));
