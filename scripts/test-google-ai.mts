// The Google-specific logic of the gateway (src/lib/google-ai.ts), against what Google really answered.
//   node --test scripts/test-google-ai.mts
// The error bodies are shortened copies of real ones (2026-11-14); the limits are the ones AI Studio showed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Loaded by path, not imported: tsc (checking scripts/ with the rest) doesn't take a ".ts" import, and Node does.
const g = (await import(new URL("../src/lib/google-ai.ts", import.meta.url).href)) as typeof import("../src/lib/google-ai");

const quota = (ids: string[], message: string, retryDelay?: string) => ({
  error: {
    code: 429,
    message,
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.Help", links: [] },
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: ids.map((quotaId) => ({ quotaId, quotaDimensions: { model: "gemini-4-argon" } })) },
      ...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []),
    ],
  },
});

describe("which limit a 429 means", () => {
  it("a model with no free quota (limit: 0) is unavailable for hours, whatever it lists", () => {
    const data = quota(
      ["GenerateContentInputTokensPerModelPerDay-FreeTier", "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "GenerateRequestsPerDayPerProjectPerModel-FreeTier"],
      "You exceeded your current quota.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-4-argon\nPlease retry in 19.5s.",
      "19s",
    );
    assert.deepEqual(g.classifyGoogleFailure(429, data), { kind: "unavailable", wait: 6 * 3600 });
  });

  it("the day's requests used up wait for midnight Pacific", () => {
    const data = quota(["GenerateRequestsPerDayPerProjectPerModel-FreeTier"], "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash", "7s");
    const now = Date.parse("2026-11-14T20:00:00Z"); // 12:00 in Pacific
    assert.deepEqual(g.classifyGoogleFailure(429, data, now), { kind: "daily", wait: 12 * 3600 + 5 });
  });

  it("a per-minute limit waits as long as Google says", () => {
    const data = quota(["GenerateRequestsPerMinutePerProjectPerModel-FreeTier"], "Quota exceeded for metric: generate_content_free_tier_requests, limit: 5", "19s");
    assert.deepEqual(g.classifyGoogleFailure(429, data), { kind: "minute", wait: 19 });
    assert.deepEqual(g.classifyGoogleFailure(429, quota(["GenerateRequestsPerMinutePerProjectPerModel-FreeTier"], "x", "1m30s")), { kind: "minute", wait: 90 });
    assert.deepEqual(g.classifyGoogleFailure(429, quota(["X-PerMinute"], "limit: 5. Please retry in 19.5s.")), { kind: "minute", wait: 20 }, "from the message when there is no RetryInfo");
  });

  it("a 429 that says nothing is a minute", () => {
    assert.deepEqual(g.classifyGoogleFailure(429, { error: { message: "Too many requests" } }), { kind: "minute", wait: 60 });
    assert.deepEqual(g.classifyGoogleFailure(429, null), { kind: "minute", wait: 60 });
  });

  it("a model that is no longer given to new keys is retired; any other 404 is the caller's", () => {
    const retired = { error: { code: 404, message: "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash", status: "NOT_FOUND" } };
    assert.deepEqual(g.classifyGoogleFailure(404, retired), { kind: "retired", wait: 6 * 3600 });
    assert.equal(g.classifyGoogleFailure(404, { error: { message: "models/nope is not found for API version v1beta" } }), undefined);
    assert.equal(g.classifyGoogleFailure(503, { error: { message: "high demand" } }), undefined);
    assert.equal(g.classifyGoogleFailure(400, { error: { message: "bad" } }), undefined);
  });

  it("unwraps the array Google sometimes puts an error in", () => {
    const inner = { error: { message: "high demand" } };
    assert.equal(g.unwrapGoogleError([inner]), inner);
    assert.equal(g.unwrapGoogleError(inner), inner);
    assert.deepEqual(g.unwrapGoogleError([1, 2]), [1, 2]);
  });
});

describe("the day's reset", () => {
  it("is midnight Pacific, in winter and in summer", () => {
    assert.equal(g.secondsUntilPacificMidnight(Date.parse("2026-11-14T20:00:00Z")), 12 * 3600 + 5, "PST: UTC-8");
    assert.equal(g.secondsUntilPacificMidnight(Date.parse("2026-07-14T19:00:00Z")), 12 * 3600 + 5, "PDT: UTC-7");
    assert.equal(g.secondsUntilPacificMidnight(Date.parse("2026-11-15T07:59:59Z")), 1 + 5, "a second before");
    assert.equal(g.secondsUntilPacificMidnight(Date.parse("2026-11-15T08:00:00Z")), 86_400 + 5, "at midnight: a whole day");
  });
});

describe("cooldowns", () => {
  it("hold a key off a model until it's over, and only that model", () => {
    const c = new g.Cooldowns();
    const t = 1_000_000;
    c.set("KEY1", "models/gemini-3.6-flash", { kind: "minute", wait: 30 }, undefined, t);
    assert.deepEqual(c.hold("KEY1", "gemini-3.6-flash", t + 1_000), { wait: 29, kind: "minute" }, "the same model with or without models/");
    assert.equal(c.hold("KEY1", "gemini-3.8-flash", t), undefined);
    assert.equal(c.hold("KEY2", "gemini-3.6-flash", t), undefined);
    assert.equal(c.hold("KEY1", "gemini-3.6-flash", t + 30_000), undefined, "over");
    c.set("KEY1", "gemini-3.6-flash", { kind: "daily", wait: 60 }, undefined, t);
    c.clear();
    assert.equal(c.hold("KEY1", "gemini-3.6-flash", t), undefined);
  });

  it("keep Google's answer for what won't change, so a caller is told it and not to retry", () => {
    const c = new g.Cooldowns();
    const response = { status: 404, data: { error: { message: "no longer available to new users" } } };
    c.set("KEY1", "gemini-2.5-flash", { kind: "retired", wait: 6 * 3600 }, response, 0);
    assert.deepEqual(c.hold("KEY1", "gemini-2.5-flash", 1000), { wait: 6 * 3600 - 1, kind: "retired", response });
    c.set("KEY2", "gemini-3.6-flash", { kind: "daily", wait: 60 }, response, 0);
    assert.equal(c.hold("KEY2", "gemini-3.6-flash", 1000)?.response, undefined, "a day's limit isn't final");
    assert.ok(g.isFinal("retired") && g.isFinal("unavailable") && !g.isFinal("daily") && !g.isFinal("minute"));
  });
});

describe("thought signatures", () => {
  const response = (id: string, extra?: unknown) => ({
    choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "get_time", arguments: "{}" }, ...(extra ? { extra_content: extra } : {}) }] } }],
  });
  const REAL = { google: { thought_signature: "EmAKXgFp…real" } };
  const history = (id: string, extra?: unknown) => ({
    model: "gemini-3.5-flash-lite",
    messages: [
      { role: "user", content: "time?" },
      { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "get_time", arguments: "{}" }, ...(extra ? { extra_content: extra } : {}) }] },
      { role: "tool", tool_call_id: id, content: "14:32" },
    ],
  });
  const callOf = (body: Record<string, unknown>) => ((body.messages as { tool_calls?: { extra_content?: unknown }[] }[])[1].tool_calls as { extra_content?: unknown }[])[0];

  it("puts back the signature a call came with, found by the call's id", () => {
    const b = new g.SignatureBridge();
    b.remember(response("call_1", REAL));
    assert.deepEqual(callOf(b.restore(history("call_1"))).extra_content, REAL);
  });

  it("uses Google's placeholder for a call it never saw (a restart, a call made up by the caller)", () => {
    const b = new g.SignatureBridge();
    assert.deepEqual(callOf(b.restore(history("call_unknown"))).extra_content, { google: { thought_signature: "skip_thought_signature_validator" } });
  });

  it("leaves a call that already has one, and changes nothing it doesn't have to", () => {
    const b = new g.SignatureBridge();
    const own = { google: { thought_signature: "caller's own" } };
    const body = history("call_2", own);
    assert.equal(b.restore(body), body, "the same object");
    const plain = { model: "m", messages: [{ role: "user", content: "hi" }] };
    assert.equal(b.restore(plain), plain);
    assert.equal(b.restore({ model: "m" }).model, "m");
  });

  it("doesn't change what it is given", () => {
    const b = new g.SignatureBridge();
    const body = history("call_3");
    const before = JSON.stringify(body);
    b.restore(body);
    assert.equal(JSON.stringify(body), before);
  });

  it("forgets the oldest past its size, and what is too old", () => {
    const b = new g.SignatureBridge(2, 1000);
    b.remember(response("a", REAL), 0);
    b.remember(response("b", REAL), 0);
    b.remember(response("c", REAL), 0);
    assert.equal(b.size, 2);
    assert.equal(callOf(b.restore(history("a"), 1)).extra_content && (callOf(b.restore(history("a"), 1)).extra_content as typeof REAL).google.thought_signature, "skip_thought_signature_validator", "a was pushed out");
    assert.deepEqual(callOf(b.restore(history("c"), 1)).extra_content, REAL);
    assert.equal((callOf(b.restore(history("c"), 5000)).extra_content as typeof REAL).google.thought_signature, "skip_thought_signature_validator", "c is too old");
  });

  it("ignores answers without tool calls", () => {
    const b = new g.SignatureBridge();
    b.remember({ choices: [{ message: { content: "hi" } }] });
    b.remember(null);
    b.remember({ error: "x" });
    assert.equal(b.size, 0);
  });
});

describe("usage", () => {
  it("counts a thinking model's thoughts as output", () => {
    assert.deepEqual(g.withThoughts({ prompt_tokens: 8, completion_tokens: 0, total_tokens: 107 }), { prompt_tokens: 8, completion_tokens: 99, total_tokens: 107 });
    const plain = { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 };
    assert.equal(g.withThoughts(plain), plain);
    assert.equal(g.withThoughts(null), null);
    assert.equal(g.withThoughts(undefined), undefined);
  });

  it("reads a native answer's usage, a Decisions one, and none", () => {
    assert.deepEqual(g.nativeUsage({ usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 105, totalTokenCount: 119 } }), { prompt_tokens: 14, completion_tokens: 105, total_tokens: 119 });
    assert.deepEqual(g.nativeUsage({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0, totalTokenCount: 107 } }), { prompt_tokens: 8, completion_tokens: 99, total_tokens: 107 });
    assert.deepEqual(g.nativeUsage({ usage: { total_input_tokens: 100, total_output_tokens: 0, total_tokens: 100 } }), { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 });
    assert.equal(g.nativeUsage({ answers: {} }), null);
    assert.equal(g.nativeUsage(null), null);
  });
});

describe("speech and transcription", () => {
  const answer = (mimeType: string, bytes: Uint8Array) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } }] } }] });
  const pcm = Uint8Array.from({ length: 48_000 }, (_, i) => i % 251); // one second at 24 kHz

  it("wraps raw PCM in a WAV header, whichever way Google spells the type", () => {
    for (const mime of ["audio/L16;codec=pcm;rate=24000", "audio/l16; rate=24000; channels=1"]) {
      const wav = g.wavFromAnswer(answer(mime, pcm))!;
      assert.equal(wav.mime, "audio/wav");
      assert.equal(wav.bytes.length, 44 + pcm.length);
      assert.equal(Buffer.from(wav.bytes.slice(0, 4)).toString(), "RIFF");
      assert.equal(Buffer.from(wav.bytes.slice(8, 16)).toString(), "WAVEfmt ");
      const view = new DataView(wav.bytes.buffer);
      assert.equal(view.getUint32(24, true), 24_000, "sample rate");
      assert.equal(view.getUint32(40, true), pcm.length, "data size");
      assert.equal(view.getUint32(4, true), 36 + pcm.length);
      assert.deepEqual([...wav.bytes.slice(44, 50)], [...pcm.slice(0, 6)]);
      assert.equal(wav.durationMs, 1000);
    }
  });

  it("leaves audio that is already a WAV file alone: wrapped again it would click", () => {
    const file = g.wavFromAnswer(answer("audio/L16;rate=24000", pcm))!.bytes;
    for (const mime of ["audio/wav", "audio/x-wav", "application/octet-stream"]) {
      const out = g.wavFromAnswer(answer(mime, file))!;
      assert.deepEqual([...out.bytes], [...file], mime);
      assert.equal(out.durationMs, 1000);
    }
  });

  it("says so when there is no audio", () => {
    assert.equal(g.wavFromAnswer({ candidates: [{ content: { parts: [{ text: "no" }] } }] }), undefined);
    assert.equal(g.wavFromAnswer({ error: "x" }), undefined);
    assert.equal(g.wavFromAnswer(null), undefined);
  });

  it("asks for speech with a voice, and the style as director's notes", () => {
    const body = g.speechBody("Hello", "Kore", "Say cheerfully") as { contents: { parts: { text: string }[] }[]; generationConfig: { responseModalities: string[]; speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } } };
    assert.equal(body.contents[0].parts[0].text, "### DIRECTOR'S NOTES\nStyle: Say cheerfully\n\n#### TRANSCRIPT\nHello");
    assert.deepEqual(body.generationConfig.responseModalities, ["AUDIO"]);
    assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
    assert.equal((g.speechBody("Hello", "Puck") as typeof body).contents[0].parts[0].text, "Hello");
  });

  it("reads the transcript from the part Gemini 3.5 Transcribe uses, or from text", () => {
    const t = (parts: unknown[]) => ({ candidates: [{ content: { parts } }] });
    assert.equal(g.transcriptFrom(t([{ audioTranscription: { text: "The quick brown fox." } }])), "The quick brown fox.");
    assert.equal(g.transcriptFrom(t([{ text: "One " }, { text: "two" }])), "One two");
    assert.equal(g.transcriptFrom(t([])), "");
    assert.equal(g.transcriptFrom(null), "");
  });
});

describe("interactions", () => {
  it("remember the key that made them", () => {
    const k = new g.StickyKeys(2);
    k.remember("i1", "KEY3");
    k.remember("i2", "KEY4");
    k.remember("i3", "KEY5");
    k.remember(undefined, "KEY9");
    assert.equal(k.get("i1"), undefined, "pushed out");
    assert.equal(k.get("i3"), "KEY5");
    assert.equal(k.get(undefined), undefined);
  });
});

describe("the models", () => {
  it("offers the chat models a key can use, and not retired ones or aliases", () => {
    assert.deepEqual(g.googleChatModels().map((m) => m.id), [
      "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-4-hydrogen", "gemini-robotics-er-2-preview",
    ]);
    assert.ok(g.googleChatModels().some((m) => m.id === g.GOOGLE_DEFAULT_CHAT_MODEL));
    assert.equal(g.googleModelId("models/gemini-3.6-flash"), "gemini-3.6-flash");
  });

  it("has the free-tier limits AI Studio shows", () => {
    const L = g.GOOGLE_LIMITS;
    const row = (id: string, rpm: number, tpm: number, rpd: number) => assert.deepEqual(L[id], { requestsPerMin: rpm, tokensPerMin: tpm, requestsPerDay: rpd }, id);
    for (const id of ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]) row(id, 15, 250_000, 500);
    row("gemini-2.5-flash-lite", 10, 250_000, 20);
    for (const id of ["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-4-hydrogen", "gemini-robotics-er-2-preview"]) row(id, 5, 250_000, 20);
    for (const id of ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]) row(id, 3, 10_000, 10);
    row("gemini-3.5-transcribe", 3, 10_000, 25);
    for (const id of ["gemini-embedding-001", "gemini-embedding-2"]) row(id, 100, 30_000, 1_000);
    row("antigravity-preview-09-2026", 60, 100_000, 100);
    row("gemini-decision-1", 200, 50_000, 10_000);
  });

  it("says which are retired for new keys", () => {
    assert.deepEqual(g.GOOGLE_MODELS.filter((m) => m.retired).map((m) => m.id).sort(), ["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
  });
});

describe("what kind of audio a file is", () => {
  const bytes = (...b: (number | string)[]) => Uint8Array.from(b.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));
  const pad = (b: Uint8Array) => Uint8Array.from([...b, ...new Array(16).fill(0)]);

  it("goes by the first bytes, whatever the client called it (curl says application/octet-stream)", () => {
    assert.equal(g.audioMimeType(pad(bytes("RIFF", 1, 2, 3, 4, "WAVE")), "application/octet-stream", "tts.wav"), "audio/wav");
    assert.equal(g.audioMimeType(pad(bytes("OggS")), "application/octet-stream"), "audio/ogg");
    assert.equal(g.audioMimeType(pad(bytes("fLaC")), ""), "audio/flac");
    assert.equal(g.audioMimeType(pad(bytes(0, 0, 0, 0x20, "ftypM4A ")), "application/octet-stream"), "audio/mp4");
    assert.equal(g.audioMimeType(pad(bytes(0x1a, 0x45, 0xdf, 0xa3)), "video/webm"), "audio/webm");
    assert.equal(g.audioMimeType(pad(bytes("ID3", 4)), undefined), "audio/mp3");
    assert.equal(g.audioMimeType(pad(bytes("FORM", 0, 0, 0, 0, "AIFF")), undefined), "audio/aiff");
  });

  it("tells an MP3 frame from AAC in ADTS by the layer bits", () => {
    assert.equal(g.audioMimeType(pad(bytes(0xff, 0xfb, 0x90)), undefined), "audio/mp3");
    assert.equal(g.audioMimeType(pad(bytes(0xff, 0xf1, 0x50)), undefined), "audio/aac");
  });

  it("falls back to an audio type the client gave, then to the extension, then to not knowing", () => {
    const unknown = pad(bytes(1, 2, 3, 4, 5, 6, 7, 8));
    assert.equal(g.audioMimeType(unknown, "audio/mpeg; codecs=x"), "audio/mp3");
    assert.equal(g.audioMimeType(unknown, "audio/x-wav"), "audio/wav");
    assert.equal(g.audioMimeType(unknown, "application/octet-stream", "talk.M4A"), "audio/mp4");
    assert.equal(g.audioMimeType(unknown, "application/octet-stream", "notes.txt"), undefined);
    assert.equal(g.audioMimeType(new Uint8Array(0), undefined, undefined), undefined);
  });
});

describe("the text a speech model is sent", () => {
  it("is the text itself without a style", () => {
    assert.equal(g.speechPrompt("Hello.", undefined), "Hello.");
    assert.equal(g.speechPrompt("Hello.", "  "), "Hello.");
  });

  it("keeps the style apart from the transcript, which Gemini TTS reads aloud when it is in front", () => {
    const prompt = g.speechPrompt("Good evening!", "Calm, like a radio host.");
    assert.ok(prompt.startsWith("### DIRECTOR'S NOTES\nStyle: Calm, like a radio host."));
    assert.ok(prompt.endsWith("#### TRANSCRIPT\nGood evening!"));
    const body = g.speechBody("Good evening!", "Kore", "Calm") as { contents: { parts: { text: string }[] }[] };
    assert.equal(body.contents[0].parts[0].text, g.speechPrompt("Good evening!", "Calm"));
  });
});
