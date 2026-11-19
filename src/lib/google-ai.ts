// Google AI Studio (the Gemini API), the parts of it that are particular to Google. The rotation over
// GOOGLE_AI_STUDIO_API_KEY1..N and the calls themselves are in ai-providers.ts; this file is what they
// consult: which models there are and their free-tier limits, how to read a 429 (which limit, and when it
// clears), how to keep Gemini 3's tool calling working for callers that don't know about thought signatures,
// and how to turn speech and transcription between Google's shapes and plain audio and text.
//
// No runtime imports, so it runs under plain Node in scripts/test-google-ai.mts.

export type GoogleLimits = {
  requestsPerMin?: number;
  requestsPerDay?: number;
  tokensPerMin?: number;
};

export type GoogleModelKind = "chat" | "embedding" | "speech" | "transcribe" | "decision" | "agent";

export type GoogleModel = {
  id: string;
  name: string;
  kind: GoogleModelKind;
  // The free tier's limits per project, as AI Studio shows them (2026-11-14). A limit is per Google Cloud project,
  // not per key: keys from one project share it.
  limits: GoogleLimits;
  // On the list AI Studio shows, but not usable with a key made now (checked 2026-11-14 on all ten keys).
  retired?: boolean;
  // Another id for a model that is listed already: left out of the model lists.
  alias?: boolean;
  // What the model is, when its id doesn't say.
  note?: string;
};

const FLASH_LITE: GoogleLimits = { requestsPerMin: 15, tokensPerMin: 250_000, requestsPerDay: 500 };
const FLASH: GoogleLimits = { requestsPerMin: 5, tokensPerMin: 250_000, requestsPerDay: 20 };
const SPEECH: GoogleLimits = { requestsPerMin: 3, tokensPerMin: 10_000, requestsPerDay: 10 };
const EMBEDDING: GoogleLimits = { requestsPerMin: 100, tokensPerMin: 30_000, requestsPerDay: 1_000 };

export const GOOGLE_MODELS: GoogleModel[] = [
  // Text, over the OpenAI-compatible endpoint (/chat/completions).
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", kind: "chat", limits: FLASH_LITE },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", kind: "chat", limits: FLASH_LITE },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (preview)", kind: "chat", limits: FLASH },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", kind: "chat", limits: FLASH },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", kind: "chat", limits: FLASH, note: "often overloaded (503 or no answer)" },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", kind: "chat", limits: FLASH },
  { id: "gemini-robotics-er-2-preview", name: "Gemini Robotics-ER 2 (preview)", kind: "chat", limits: FLASH },
  // In AI Studio's table, but "no longer available to new users": 404 on every key.
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", kind: "chat", limits: { requestsPerMin: 10, tokensPerMin: 250_000, requestsPerDay: 20 }, retired: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", kind: "chat", limits: FLASH, retired: true },
  // Aliases of the above that AI Studio also lists.
  { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash-Lite (preview)", kind: "chat", limits: FLASH_LITE, alias: true },

  { id: "gemini-embedding-001", name: "Gemini Embedding 1", kind: "embedding", limits: EMBEDDING },
  { id: "gemini-embedding-2", name: "Gemini Embedding 2", kind: "embedding", limits: EMBEDDING },
  { id: "gemini-embedding-2-preview", name: "Gemini Embedding 2 (preview)", kind: "embedding", limits: EMBEDDING, alias: true },

  { id: "gemini-3.8-flash-lite-tts", name: "Gemini 3.8 Flash-Lite TTS", kind: "speech", limits: SPEECH },
  { id: "gemini-3.8-flash-tts", name: "Gemini 3.8 Flash TTS", kind: "speech", limits: SPEECH },
  { id: "gemini-3.1-flash-tts-preview", name: "Gemini 3.1 Flash TTS (preview)", kind: "speech", limits: SPEECH },
  { id: "gemini-2.5-flash-preview-tts", name: "Gemini 2.5 Flash TTS (preview)", kind: "speech", limits: SPEECH },

  // Speech to text. The Live API one (gemini-3.5-transcribe-live) is a WebSocket, which this gateway can't carry.
  { id: "gemini-3.5-transcribe", name: "Gemini 3.5 Transcribe", kind: "transcribe", limits: { requestsPerMin: 3, tokensPerMin: 10_000, requestsPerDay: 25 } },

  // Their own endpoints (/v1beta/decisions and /v1beta/interactions).
  { id: "gemini-decision-1", name: "Gemini Decision 1", kind: "decision", limits: { requestsPerMin: 200, tokensPerMin: 50_000, requestsPerDay: 10_000 } },
  { id: "antigravity-preview-09-2026", name: "Antigravity agent (preview)", kind: "agent", limits: { requestsPerMin: 60, tokensPerMin: 100_000, requestsPerDay: 100 } },
  { id: "antigravity-preview-05-2026", name: "Antigravity agent (preview, May)", kind: "agent", limits: { requestsPerMin: 60, tokensPerMin: 100_000, requestsPerDay: 100 }, alias: true },
  { id: "antigravity-preview-latest", name: "Antigravity agent (latest preview)", kind: "agent", limits: { requestsPerMin: 60, tokensPerMin: 100_000, requestsPerDay: 100 }, alias: true },
];

export const GOOGLE_LIMITS: Record<string, GoogleLimits> = Object.fromEntries(GOOGLE_MODELS.map((m) => [m.id, m.limits]));

export const GOOGLE_DEFAULT_CHAT_MODEL = "gemini-3.5-flash-lite";
export const GOOGLE_DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const GOOGLE_DEFAULT_SPEECH_MODEL = "gemini-3.8-flash-lite-tts";
export const GOOGLE_DEFAULT_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
export const GOOGLE_DECISION_MODEL = "gemini-decision-1";
export const GOOGLE_AGENT_MODEL = "antigravity-preview-09-2026";

// The models the chat model list offers: the text ones a key can use, not the aliases.
export function googleChatModels(): { id: string; name: string }[] {
  return GOOGLE_MODELS.filter((m) => m.kind === "chat" && !m.retired && !m.alias).map((m) => ({ id: m.id, name: m.name }));
}

// Google writes model ids as "models/gemini-3.6-flash" in its lists and errors.
export const googleModelId = (model: string): string => model.replace(/^models\//, "");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Google's OpenAI-compatible endpoint sometimes wraps an error in an array: [{"error": {...}}].
export function unwrapGoogleError(data: unknown): unknown {
  return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

export type GoogleFailure = {
  // daily: this key has used the model's requests (or tokens) for the day. minute: the per-minute limit, so a
  // short wait. unavailable: the free tier gives this model no quota at all (limit 0). retired: "no longer
  // available to new users". Neither of those two will change soon.
  kind: "daily" | "minute" | "unavailable" | "retired";
  wait: number; // seconds until it is worth asking this key for this model again
};

const SIX_HOURS = 6 * 3600;

// The date, as "2026-11-18", in Pacific time: the day Google counts a key's daily limits in.
export function pacificDate(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const n = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${n("year")}-${n("month")}-${n("day")}`;
}

// Seconds until midnight in Pacific time, when Google resets the daily limits. Intl knows about daylight saving.
export function secondsUntilPacificMidnight(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(now));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Math.max(1, 86_400 - (n("hour") * 3600 + n("minute") * 60 + n("second")) + 5);
}

// "19s", "0.5s", "1m30s" → seconds.
function delaySeconds(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length) return undefined;
  const unit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
  return Math.ceil(parts.reduce((sum, [, amount, u]) => sum + Number(amount) * unit[u], 0));
}

// Which limit a 404 or 429 means. undefined: neither, so it's a real answer for the caller (a 404 for a model that
// doesn't exist, say). `data` is the body, already unwrapped.
export function classifyGoogleFailure(status: number, data: unknown, now = Date.now()): GoogleFailure | undefined {
  const error = (data as { error?: { message?: unknown; details?: unknown } } | null)?.error;
  const message = typeof error?.message === "string" ? error.message : "";
  if (status === 404) {
    return /no longer available to new users/i.test(message) ? { kind: "retired", wait: SIX_HOURS } : undefined;
  }
  if (status !== 429) return undefined;

  const details = Array.isArray(error?.details) ? (error.details as Record<string, unknown>[]) : [];
  const quotaIds = details
    .filter((d) => String(d["@type"] ?? "").endsWith("QuotaFailure"))
    .flatMap((d) => (Array.isArray(d.violations) ? (d.violations as { quotaId?: unknown }[]) : []))
    .map((v) => String(v.quotaId ?? ""));
  const retryInfo = details.find((d) => String(d["@type"] ?? "").endsWith("RetryInfo"));
  const retry =
    (typeof retryInfo?.retryDelay === "string" ? delaySeconds(retryInfo.retryDelay) : undefined) ??
    delaySeconds(/retry in ([\d.]+s)/i.exec(message)?.[1] ?? "");

  // "limit: 0": this model has no free quota for the project at all.
  if (/limit:\s*0\b/.test(message)) return { kind: "unavailable", wait: SIX_HOURS };
  if (quotaIds.some((q) => /PerDay/i.test(q)) || (!quotaIds.length && /per day/i.test(message))) {
    return { kind: "daily", wait: secondsUntilPacificMidnight(now) };
  }
  return { kind: "minute", wait: Math.max(1, retry ?? 60) };
}

// ---------------------------------------------------------------------------
// Which key may be asked about which model
// ---------------------------------------------------------------------------

// Google's own answer, kept for the cases that won't change soon.
export type GoogleResponse = { status: number; data: unknown };

// "retired" and "unavailable" are for good, as far as a caller is concerned: it should be told what Google said,
// not asked to retry in six hours.
export const isFinal = (kind: GoogleFailure["kind"]): boolean => kind === "retired" || kind === "unavailable";

export type Hold = { wait: number; kind: GoogleFailure["kind"]; response?: GoogleResponse };

// A key that has just said "not now" for a model isn't asked again for that model until it's over. In memory, so
// a restart costs at most one refused request per key and model.
export class Cooldowns {
  private readonly until = new Map<string, { end: number; kind: GoogleFailure["kind"]; response?: GoogleResponse }>();

  // Why a key may not be asked about a model, or undefined when it may.
  hold(keyName: string, model: string, now = Date.now()): Hold | undefined {
    const id = `${keyName}|${googleModelId(model)}`;
    const entry = this.until.get(id);
    if (!entry) return undefined;
    if (entry.end <= now) {
      this.until.delete(id);
      return undefined;
    }
    return { wait: Math.ceil((entry.end - now) / 1000), kind: entry.kind, ...(entry.response ? { response: entry.response } : {}) };
  }

  set(keyName: string, model: string, failure: GoogleFailure, response?: GoogleResponse, now = Date.now()): void {
    if (this.until.size > 2_000) for (const [k, e] of this.until) if (e.end <= now) this.until.delete(k);
    this.until.set(`${keyName}|${googleModelId(model)}`, {
      end: now + failure.wait * 1000,
      kind: failure.kind,
      ...(response && isFinal(failure.kind) ? { response } : {}),
    });
  }

  clear(): void {
    this.until.clear();
  }
}

// ---------------------------------------------------------------------------
// Tool calls: Gemini 3's thought signatures
// ---------------------------------------------------------------------------

// A Gemini 3 model that calls a tool attaches a signature to the call (extra_content.google.thought_signature)
// and refuses the next turn, with HTTP 400, if the call comes back without it. Callers that rebuild their tool
// calls from the fields they know (the VS Code extension, the Chrome agent) drop it. So the gateway keeps each
// signature by the call's id, puts it back, and where it has none (a restart, a call made up by the caller) sends
// the value Google documents for exactly that: "skip_thought_signature_validator". Measured: 400 without any,
// 200 with the real one, 200 with the placeholder, on three Gemini 3 models.
export const PLACEHOLDER_SIGNATURE = "skip_thought_signature_validator";

type ToolCall = { id?: unknown; extra_content?: unknown; [field: string]: unknown };

export class SignatureBridge {
  private readonly seen = new Map<string, { extra: unknown; at: number }>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max = 5_000, ttlMs = 24 * 3600_000) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  // What a response carries: its tool calls' signatures.
  remember(data: unknown, now = Date.now()): void {
    const choices = (data as { choices?: { message?: { tool_calls?: ToolCall[] } }[] } | null)?.choices;
    for (const choice of choices ?? []) {
      for (const call of choice?.message?.tool_calls ?? []) {
        if (typeof call.id !== "string" || !call.extra_content) continue;
        this.seen.delete(call.id);
        this.seen.set(call.id, { extra: call.extra_content, at: now });
      }
    }
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
  }

  // The request with every assistant tool call that lacks its signature given one. Not changed in place.
  restore(body: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const messages = body.messages;
    if (!Array.isArray(messages)) return body;
    let changed = false;
    const fixed = messages.map((m) => {
      const calls = (m as { role?: unknown; tool_calls?: unknown } | null)?.tool_calls;
      if (!Array.isArray(calls) || (m as { role?: unknown }).role !== "assistant") return m;
      const withSignatures = (calls as ToolCall[]).map((call) => {
        if (!call || typeof call !== "object" || call.extra_content) return call;
        changed = true;
        const known = typeof call.id === "string" ? this.seen.get(call.id) : undefined;
        const extra = known && now - known.at < this.ttlMs ? known.extra : { google: { thought_signature: PLACEHOLDER_SIGNATURE } };
        return { ...call, extra_content: extra };
      });
      return { ...(m as object), tool_calls: withSignatures };
    });
    return changed ? { ...body, messages: fixed } : body;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

// A thinking model's thoughts are in total_tokens but not in completion_tokens (measured: 8 + 0, total 107),
// and Google bills them as output. Counted as completion so what a caller is charged matches.
export function withThoughts<T extends Usage | null | undefined>(usage: T): T {
  if (!usage) return usage;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  return total > prompt + completion ? { ...usage, completion_tokens: total - prompt } : usage;
}

// Usage from a native generateContent answer, or a Decisions or Interactions one.
export function nativeUsage(data: unknown): Usage | null {
  const d = data as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    usage?: { total_input_tokens?: number; total_output_tokens?: number; total_tokens?: number };
  } | null;
  if (d?.usageMetadata) {
    const u = d.usageMetadata;
    const prompt = u.promptTokenCount ?? 0;
    const total = u.totalTokenCount ?? prompt + (u.candidatesTokenCount ?? 0);
    return { prompt_tokens: prompt, completion_tokens: Math.max(u.candidatesTokenCount ?? 0, total - prompt), total_tokens: total };
  }
  if (d?.usage && (d.usage.total_input_tokens !== undefined || d.usage.total_tokens !== undefined)) {
    const prompt = d.usage.total_input_tokens ?? 0;
    const completion = d.usage.total_output_tokens ?? 0;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: d.usage.total_tokens ?? prompt + completion };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Speech and transcription
// ---------------------------------------------------------------------------

// The type Google wants named for audio it is sent inline. Clients label uploads loosely (curl says
// application/octet-stream for a .wav), so the file's own first bytes decide; then a type the client gave that is
// audio, then the file's extension. undefined when it can't be told: Google refuses a type it doesn't know.
const AUDIO_EXTENSIONS: Record<string, string> = {
  wav: "audio/wav", wave: "audio/wav", mp3: "audio/mp3", mpeg: "audio/mp3", mpga: "audio/mp3", m4a: "audio/mp4", mp4: "audio/mp4",
  aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", aif: "audio/aiff", aiff: "audio/aiff",
  webm: "audio/webm",
};

export function audioMimeType(bytes: Uint8Array, declared?: string, filename?: string): string | undefined {
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "audio/wav";
  if (bytes.length >= 12 && text(0, 4) === "FORM" && (text(8, 12) === "AIFF" || text(8, 12) === "AIFC")) return "audio/aiff";
  if (bytes.length >= 4 && text(0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 4 && text(0, 4) === "fLaC") return "audio/flac";
  if (bytes.length >= 8 && text(4, 8) === "ftyp") return "audio/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (bytes.length >= 3 && text(0, 3) === "ID3") return "audio/mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // The two layer bits: 00 is AAC in ADTS, anything else is MPEG audio.
    return ((bytes[1] >> 1) & 3) === 0 ? "audio/aac" : "audio/mp3";
  }
  const type = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("audio/")) return type === "audio/mpeg" ? "audio/mp3" : type === "audio/x-wav" || type === "audio/wave" ? "audio/wav" : type;
  const ext = (filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS[ext];
}

// The prebuilt voices Google documents for Gemini TTS, with how it describes each. Kore and Puck were tried here; an
// unknown name is refused by Google with its own message.
export const GOOGLE_VOICES: { id: string; style: string }[] = Object.entries({
  Zephyr: "Bright", Puck: "Upbeat", Charon: "Informative", Kore: "Firm", Fenrir: "Excitable", Leda: "Youthful", Orus: "Firm",
  Aoede: "Breezy", Callirrhoe: "Easy-going", Autonoe: "Bright", Enceladus: "Breathy", Iapetus: "Clear", Umbriel: "Easy-going",
  Algieba: "Smooth", Despina: "Smooth", Erinome: "Clear", Algenib: "Gravelly", Rasalgethi: "Informative", Laomedeia: "Upbeat",
  Achernar: "Soft", Alnilam: "Firm", Schedar: "Even", Gacrux: "Mature", Pulcherrima: "Forward", Achird: "Friendly",
  Zubenelgenubi: "Casual", Vindemiatrix: "Gentle", Sadachbia: "Lively", Sadaltager: "Knowledgeable", Sulafat: "Warm",
}).map(([id, style]) => ({ id, style }));

// What Gemini TTS is sent as the text: the style direction ("cheerful, like an advert") goes in Google's
// "director's notes" form, apart from the transcript. Put in front as "<style>: <text>" the model reads the style
// aloud (tried: "Calm, like a radio host: Good evening" was spoken from "Calm"), and so does a bracketed one.
export function speechPrompt(input: string, instructions?: string): string {
  const style = (instructions ?? "").trim();
  return style ? `### DIRECTOR'S NOTES\nStyle: ${style}\n\n#### TRANSCRIPT\n${input}` : input;
}

// The body of a native text-to-speech call.
export function speechBody(input: string, voice: string, instructions?: string): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text: speechPrompt(input, instructions) }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
}

function wavHeader(pcmBytes: number, rate: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcmBytes, true);
  return header;
}

// The audio of a native answer as a WAV file. Google's models don't agree on the format: two answer "audio/wav"
// (already a file: wrapped again it would click), one raw "audio/l16; rate=24000", one "audio/L16;codec=pcm;rate=24000".
export function wavFromAnswer(data: unknown): { bytes: Uint8Array; mime: "audio/wav"; durationMs: number } | undefined {
  const parts = (data as { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[] } | null)
    ?.candidates?.[0]?.content?.parts;
  const audio = parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!audio?.data) return undefined;
  const raw = Uint8Array.from(Buffer.from(audio.data, "base64"));
  const mime = (audio.mimeType ?? "").toLowerCase();
  if (mime.includes("wav") || (raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46)) {
    const rate = raw.length >= 28 ? new DataView(raw.buffer, raw.byteOffset).getUint32(24, true) : 24_000;
    return { bytes: raw, mime: "audio/wav", durationMs: Math.round(((raw.length - 44) / (rate * 2)) * 1000) };
  }
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24_000);
  const wav = new Uint8Array(44 + raw.length);
  wav.set(wavHeader(raw.length, rate));
  wav.set(raw, 44);
  return { bytes: wav, mime: "audio/wav", durationMs: Math.round((raw.length / (rate * 2)) * 1000) };
}

// The transcript in a native answer: Gemini 3.5 Transcribe answers in audioTranscription parts, other models in text ones.
export function transcriptFrom(data: unknown): string {
  const parts = (data as { candidates?: { content?: { parts?: { text?: string; audioTranscription?: { text?: string } }[] } }[] } | null)
    ?.candidates?.[0]?.content?.parts;
  return (parts ?? [])
    .map((p) => p.audioTranscription?.text ?? p.text ?? "")
    .join("")
    .trim();
}

// ---------------------------------------------------------------------------
// Interactions (the Antigravity agents) remember which key made them
// ---------------------------------------------------------------------------

// An interaction lives in the project of the key that created it, and a later call (a follow-up with
// previous_interaction_id, a status check, a cancel) has to use the same key.
export class StickyKeys {
  private readonly keys = new Map<string, string>();
  private readonly max: number;

  constructor(max = 5_000) {
    this.max = max;
  }

  remember(id: unknown, keyName: string): void {
    if (typeof id !== "string" || !id) return;
    this.keys.delete(id);
    this.keys.set(id, keyName);
    while (this.keys.size > this.max) this.keys.delete(this.keys.keys().next().value as string);
  }

  get(id: unknown): string | undefined {
    return typeof id === "string" ? this.keys.get(id) : undefined;
  }
}

// What is shared across requests, for the lifetime of the process.
export const cooldowns = new Cooldowns();
export const signatures = new SignatureBridge();
export const interactions = new StickyKeys();
