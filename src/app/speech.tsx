"use client";

// The Playground's speech modes. Speech to text sends a recording or an audio
// file to /api/transcribe, for Groq's Whisper or MiMo's speech recognition
// page; text to speech sends text to /api/speech, MiMo's speech page, and
// plays what comes back. A spoken clip can be transcribed in one click, to
// check one against the other.

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Icon } from "./icons";
import styles from "./page.module.css";
import { CopyButton } from "./ui";

export type SpeechMode = "transcribe" | "speak";

type Provider = "groq" | "mimo";

const PROVIDER_NAMES: Record<Provider, string> = { groq: "Groq", mimo: "MiMo" };

// "" leaves it to the server: GROQ_TRANSCRIBE_MODEL, or whisper-large-v3-turbo.
const GROQ_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];

const RESPONSE_FORMATS = ["json", "verbose_json", "text"] as const;
type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

// What to record in, best first: Chrome and Firefox record WebM with Opus,
// Safari only MP4. Groq takes either.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

// VoiceClone, which copies the voice in a recording, isn't offered here.
const SPEECH_MODELS = [
  { id: "mimo-v2.5-tts", label: "MiMo-V2.5-TTS: its voices" },
  { id: "mimo-v2.5-tts-voicedesign", label: "VoiceDesign: a voice you describe" },
];
const VOICE_DESIGN = "mimo-v2.5-tts-voicedesign";

const MAX_SPEECH_CHARS = 1024;

const SPEECH_SUGGESTIONS = [
  "Good evening, and welcome to Thun Murex.",
  "The quick brown fox jumps over the lazy dog.",
  "你好，今天天气怎么样？",
];

type Clip = { blob: Blob; name: string; url: string };

type Transcript = {
  id: number;
  clip: string; // the file's name
  provider: Provider;
  model: string;
  seconds: number; // from sending it to the answer, timed here
  text: string | null; // null when it failed, and `raw` says why
  raw: string;
};

type Spoken = {
  id: number;
  input: string;
  model: string;
  voice: string;
  seconds: number;
  audio: Clip | null; // null when it failed, and `error` says why
  error: string | null;
};

type Voice = { id: string; description: string };

// The message in an error answer: ai-thun's {"error": "…"}, Groq's
// {"error": {"message": "…"}} or chatgpt-web-gateway's {"detail": …}.
function errorMessage(data: unknown, status: number): string {
  const { error, detail } = (data ?? {}) as { error?: unknown; detail?: unknown };
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  if (typeof message === "string") return message;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join("; ");
  return `Request failed (HTTP ${status})`;
}

function parseJson(text: string): { text?: unknown; model?: unknown } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// For a 429: how long every key asked to wait.
function retryNote(res: Response): string {
  const wait = res.headers.get("Retry-After");
  return wait ? ` Try again in ${wait} s.` : "";
}

// "audio/webm;codecs=opus" → "webm". Groq goes by the file name's extension.
function extensionOf(type: string): string {
  const sub = type.split(";")[0].split("/")[1] ?? "";
  const known: Record<string, string> = { mpeg: "mp3", "x-wav": "wav", wave: "wav", "x-m4a": "m4a" };
  return known[sub] ?? (sub || "webm");
}

function newClip(blob: Blob, name: string): Clip {
  return { blob, name, url: URL.createObjectURL(blob) };
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Why the microphone didn't open, from getUserMedia's error.
function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") {
    return "The microphone is blocked. Allow it for this site from the address bar, then try again.";
  }
  if (name === "NotFoundError") return "No microphone found.";
  if (name === "NotReadableError") return "Couldn't open the microphone: another app may be using it.";
  return `Couldn't open the microphone: ${err instanceof Error ? err.message : String(err)}`;
}

// `active`: on screen. The console keeps this mounted while it shows other
// pages, so clips and results are still here on coming back.
export function SpeechPlayground({
  mode,
  active,
  paused,
  unavailable,
  onModeChange,
  onManage,
}: {
  mode: SpeechMode;
  active: boolean;
  paused: string[];
  unavailable: Record<string, { note: string; phrase: string }>; // provider → why it can't answer, when it's set up wrong or not responding
  onModeChange: (mode: SpeechMode) => void;
  onManage: () => void;
}) {
  // Speech to text
  const [clip, setClip] = useState<Clip | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const [micOpening, setMicOpening] = useState(false);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [provider, setProvider] = useState<Provider>("groq");
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState<ResponseFormat>("json");
  const [temperature, setTemperature] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  // Text to speech
  const [text, setText] = useState("");
  const [speechModel, setSpeechModel] = useState(SPEECH_MODELS[0].id);
  const [voice, setVoice] = useState("");
  const [instructions, setInstructions] = useState("");
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [spoken, setSpoken] = useState<Spoken[]>([]);

  const nextId = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Let go of when the Playground closes: a recording in progress, with the
  // microphone, and the spoken clips' object URLs.
  const held = useRef({ recorder: null as MediaRecorder | null, urls: new Set<string>() });
  useEffect(() => {
    const h = held.current;
    return () => {
      if (h.recorder) {
        h.recorder.onstop = null;
        h.recorder.stop();
        h.recorder.stream.getTracks().forEach((t) => t.stop());
      }
      h.urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  // Going to another page ends a recording, which stays as the clip.
  useEffect(() => {
    if (!active) held.current.recorder?.stop();
  }, [active]);

  // The clip's object URL goes when it's replaced, or the Playground closes.
  useEffect(() => {
    if (!clip) return;
    return () => URL.revokeObjectURL(clip.url);
  }, [clip]);

  useEffect(() => {
    if (recordingSince === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [recordingSince]);

  // The voices, the first time Text to speech opens (and again after "Try again").
  useEffect(() => {
    if (!active || mode !== "speak" || voices || voicesError) return;
    let cancelled = false;
    fetch("/api/speech", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok) setVoices(data?.providers?.mimo?.voices ?? []);
        else setVoicesError(errorMessage(data, res.status));
      })
      .catch(() => {
        if (!cancelled) setVoicesError("Network error reaching /api/speech");
      });
    return () => {
      cancelled = true;
    };
  }, [active, mode, voices, voicesError]);

  const busy = mode === "transcribe" ? transcribing : speaking;
  const resultCount = mode === "transcribe" ? transcripts.length : spoken.length;
  // The newest result in view (a hidden list forgets where it was scrolled).
  useEffect(() => {
    const el = resultsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active, mode, resultCount, busy]);

  const recording = recordingSince !== null;
  const providerPaused = paused.includes(provider);
  const mimoPaused = paused.includes("mimo");
  const modelLabel = provider === "groq" ? model || "default model" : "mimo-v2.5-asr";
  const designing = speechModel === VOICE_DESIGN;
  const canSpeak = Boolean(text.trim()) && !speaking && !mimoPaused && (!designing || Boolean(instructions.trim()));

  function replaceClip(next: Clip | null) {
    setClip(next);
    setClipError(null);
  }

  function takeFile(file: File | undefined) {
    if (!file) return;
    if (file.type && !/^(audio|video)\//.test(file.type)) {
      setClipError(`${file.name} isn't an audio file.`);
      return;
    }
    replaceClip(newClip(file, file.name));
  }

  async function startRecording() {
    setClipError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setClipError("This browser can't record here: recording needs HTTPS, or localhost.");
      return;
    }
    setMicOpening(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setClipError(micError(err));
      return;
    } finally {
      setMicOpening(false);
    }
    const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      held.current.recorder = null;
      setRecordingSince(null);
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      if (blob.size > 0) replaceClip(newClip(blob, `recording.${extensionOf(blob.type)}`));
      else setClipError("Nothing was recorded.");
    };
    recorder.start();
    held.current.recorder = recorder;
    const started = Date.now();
    setNow(started);
    setRecordingSince(started);
  }

  async function transcribe() {
    if (!clip || transcribing) return;
    const form = new FormData();
    form.set("file", clip.blob, clip.name);
    form.set("provider", provider);
    // MiMo's page takes the audio only.
    if (provider === "groq") {
      if (model) form.set("model", model);
      if (language.trim()) form.set("language", language.trim());
      if (prompt.trim()) form.set("prompt", prompt.trim());
      if (format !== "json") form.set("response_format", format);
      if (temperature.trim()) form.set("temperature", temperature.trim());
    }
    const id = nextId.current++;
    const started = performance.now();
    setTranscribing(true);
    let result: Pick<Transcript, "model" | "text" | "raw">;
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const raw = await res.text();
      // response_format=text answers plain text; everything else is JSON.
      const isJson = res.headers.get("content-type")?.includes("json") ?? false;
      const data = isJson ? parseJson(raw) : null;
      const answeredBy = typeof data?.model === "string" ? data.model : modelLabel;
      if (!res.ok) result = { model: answeredBy, text: null, raw: errorMessage(data, res.status) + retryNote(res) };
      else if (!isJson) result = { model: answeredBy, text: raw.trim(), raw };
      else if (typeof data?.text === "string") {
        result = { model: answeredBy, text: data.text.trim(), raw: JSON.stringify(data, null, 2) };
      } else result = { model: answeredBy, text: null, raw: `The answer had no text in it: ${raw}` };
    } catch {
      result = { model: modelLabel, text: null, raw: "Network error reaching /api/transcribe" };
    }
    const seconds = (performance.now() - started) / 1000;
    setTranscripts((list) => [...list, { id, clip: clip.name, provider, seconds, ...result }]);
    setTranscribing(false);
  }

  async function speak(e?: FormEvent) {
    e?.preventDefault();
    if (!canSpeak) return;
    const input = text.trim();
    const body: Record<string, string> = { input, model: speechModel };
    if (!designing && voice) body.voice = voice;
    if (instructions.trim()) body.instructions = instructions.trim();
    const id = nextId.current++;
    const started = performance.now();
    setSpeaking(true);
    let result: Pick<Spoken, "voice" | "audio" | "error"> = {
      voice: designing ? "Described voice" : voice || "Default voice",
      audio: null,
      error: null,
    };
    try {
      const res = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || res.headers.get("content-type")?.includes("json")) {
        const data = await res.json().catch(() => null);
        result.error = res.ok ? "The answer had no audio in it." : errorMessage(data, res.status) + retryNote(res);
      } else {
        const blob = await res.blob();
        const sent = res.headers.get("X-Voice");
        if (sent) result.voice = decodeURIComponent(sent);
        const audio = newClip(blob, `speech-${sent ? result.voice : "mimo"}.${extensionOf(blob.type)}`);
        held.current.urls.add(audio.url);
        result = { ...result, audio };
      }
    } catch {
      result.error = "Network error reaching /api/speech";
    }
    const seconds = (performance.now() - started) / 1000;
    setSpoken((list) => [...list, { id, input, model: speechModel, seconds, ...result }]);
    setSpeaking(false);
  }

  function clearSpoken() {
    for (const s of spoken) {
      if (!s.audio) continue;
      URL.revokeObjectURL(s.audio.url);
      held.current.urls.delete(s.audio.url);
    }
    setSpoken([]);
  }

  // A spoken clip, to Speech to text (with its own URL: the two go separately).
  function transcribeSpoken(audio: Clip) {
    replaceClip(newClip(audio.blob, audio.name));
    onModeChange("transcribe");
  }

  const heldNote = (id: string) => (!paused.includes(id) ? "" : (unavailable[id]?.note ?? " (paused)"));

  const pausedNotice = (name: string, id: string) => (
    <div className={styles.notice}>
      <span>{unavailable[id] ? `${name} ${unavailable[id].phrase}` : `${name} is paused.`}</span>
      <button type="button" className={styles.linkButton} onClick={onManage}>
        {unavailable[id] ? "See the Manage page" : "Resume it on the Manage page"} <Icon name="arrow" />
      </button>
    </div>
  );

  // -------------------------------------------------------------------------
  // Speech to text
  // -------------------------------------------------------------------------

  const transcribeMain = (
    <div
      className={`${styles.playgroundMain} ${dragging ? styles.dropTarget : ""}`}
      onDragOver={(e: DragEvent) => {
        if (recording || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        takeFile(e.dataTransfer.files[0]);
      }}
    >
      <div className={styles.transcript} ref={resultsRef}>
        {transcripts.length === 0 && !transcribing ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Icon name="mic" />
            </div>
            <div className={styles.emptyTitle}>Transcribe some audio</div>
            <div className={styles.emptyDesc}>
              Record from your microphone, upload a file or drop one here. It goes to{" "}
              {PROVIDER_NAMES[provider]} · {modelLabel}.
            </div>
          </div>
        ) : (
          <>
            {transcripts.map((t) => (
              <div key={t.id} className={styles.turn}>
                <div
                  className={`${styles.turnRole} ${
                    t.text === null ? styles.turnRoleError : styles.turnRoleAssistant
                  }`}
                >
                  {t.text === null ? "Error · " : ""}
                  {PROVIDER_NAMES[t.provider]} · {t.model}
                </div>
                <div className={`${styles.turnContent} ${t.text === null ? styles.turnContentError : ""}`}>
                  {t.text === null ? t.raw : t.text || <span className={styles.dim}>Nothing was heard.</span>}
                </div>
                <div className={styles.resultMeta}>
                  <span>
                    {t.clip} · {t.seconds.toFixed(1)} s
                  </span>
                  {t.text ? <CopyButton value={t.text} /> : null}
                </div>
                {t.text !== null && (
                  <details className={styles.thinkingDetails}>
                    <summary>Raw response</summary>
                    <div className={`${styles.thinkingText} ${styles.mono}`}>{t.raw}</div>
                  </details>
                )}
              </div>
            ))}
            {transcribing && (
              <div className={styles.turn}>
                <div className={`${styles.turnRole} ${styles.turnRoleAssistant}`}>
                  {PROVIDER_NAMES[provider]} · {modelLabel}
                </div>
                <div className={styles.turnContent}>
                  <span className={styles.dim}>Transcribing</span>
                  <span className={styles.typingCursor} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className={styles.composer}>
        {providerPaused && pausedNotice(PROVIDER_NAMES[provider], provider)}
        {clipError && (
          <div className={styles.alert} style={{ marginBottom: 10 }}>
            {clipError}
          </div>
        )}
        {clip && !recording && (
          <div className={styles.clipRow}>
            <audio className={styles.clipAudio} src={clip.url} controls />
            <span className={styles.clipName}>
              {clip.name} · {formatSize(clip.blob.size)}
            </span>
            <button type="button" className={styles.buttonDanger} onClick={() => replaceClip(null)}>
              Remove
            </button>
          </div>
        )}
        <div className={styles.clipRow}>
          {recording ? (
            <>
              <span className={styles.recording}>
                <span className={styles.recordingDot} />
                Recording {formatClock(Math.max(0, now - recordingSince))}
              </span>
              <button
                type="button"
                className={`${styles.buttonGhost} ${styles.buttonStop} ${styles.clipSend}`}
                onClick={() => held.current.recorder?.stop()}
              >
                <Icon name="stop" /> Stop
              </button>
            </>
          ) : (
            <>
              <button type="button" className={styles.buttonGhost} onClick={startRecording} disabled={micOpening}>
                <Icon name="mic" /> Record
              </button>
              <button type="button" className={styles.buttonGhost} onClick={() => fileInput.current?.click()}>
                <Icon name="upload" /> Upload a file
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="audio/*,video/mp4,video/webm"
                hidden
                onChange={(e) => {
                  takeFile(e.target.files?.[0]);
                  e.target.value = ""; // so picking the same file again still counts
                }}
              />
              <button
                type="button"
                className={`${styles.button} ${styles.clipSend}`}
                onClick={transcribe}
                disabled={!clip || transcribing || providerPaused}
              >
                Transcribe <Icon name="send" />
              </button>
            </>
          )}
        </div>
        <div className={styles.runHint}>
          <span>{recording ? "Recording from your microphone" : "Or drop an audio file anywhere here"}</span>
          <span>
            {PROVIDER_NAMES[provider]} · {modelLabel}
          </span>
        </div>
      </div>
    </div>
  );

  const transcribeSettings = (
    <>
      <div className={styles.panelGroup}>
        <div className={styles.panelTitle}>Model</div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="stt-provider">
            Provider
          </label>
          <select
            id="stt-provider"
            className={styles.select}
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
          >
            <option value="groq" disabled={paused.includes("groq")}>
              {`Groq · Whisper${heldNote("groq")}`}
            </option>
            <option value="mimo" disabled={mimoPaused}>
              {`MiMo · MiMo-V2.5-ASR${heldNote("mimo")}`}
            </option>
          </select>
        </div>
        {provider === "groq" ? (
          <>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="stt-model">
                Model
              </label>
              <select id="stt-model" className={styles.select} value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Default</option>
                {GROQ_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <p className={styles.sidebarHint}>
              Whisper on Groq answers in about a second. Each Groq key allows 20 transcriptions a minute
              and 2,000 a day.
            </p>
          </>
        ) : (
          <p className={styles.sidebarHint}>
            MiMo Studio&apos;s speech recognition page, through chatgpt-web-gateway: good with noise,
            several speakers and dialects. Up to 10 MB and 90 seconds; it takes 3–10 s. It takes the audio
            only, so there&apos;s nothing to set.
          </p>
        )}
      </div>

      {provider === "groq" && (
        <div className={styles.panelGroup}>
          <div className={styles.panelTitle}>Parameters</div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="stt-language">
              Language
            </label>
            <input
              id="stt-language"
              className={styles.input}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="Detect it"
            />
            <span className={styles.fieldHint}>A code such as en, km or zh. Optional, but it helps.</span>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="stt-prompt">
              Prompt
            </label>
            <textarea
              id="stt-prompt"
              className={styles.input}
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Words or spellings to expect"
            />
          </div>
          <div className={styles.twoCol}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="stt-format">
                Format
              </label>
              <select
                id="stt-format"
                className={styles.select}
                value={format}
                onChange={(e) => setFormat(e.target.value as ResponseFormat)}
              >
                {RESPONSE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="stt-temp">
                Temperature
              </label>
              <input
                id="stt-temp"
                className={styles.input}
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="Default"
              />
            </div>
          </div>
        </div>
      )}

      <div className={styles.panelGroup}>
        <div className={styles.panelTitle}>Results</div>
        <div className={styles.statList}>
          <div className={styles.statListRow}>
            <span>Transcripts</span>
            <span>{transcripts.length}</span>
          </div>
        </div>
        <button
          type="button"
          className={styles.buttonGhost}
          onClick={() => setTranscripts([])}
          disabled={transcripts.length === 0}
        >
          Clear
        </button>
      </div>
    </>
  );

  // -------------------------------------------------------------------------
  // Text to speech
  // -------------------------------------------------------------------------

  const speakMain = (
    <div className={styles.playgroundMain}>
      <div className={styles.transcript} ref={resultsRef}>
        {spoken.length === 0 && !speaking ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Icon name="speaker" />
            </div>
            <div className={styles.emptyTitle}>Hear it spoken</div>
            <div className={styles.emptyDesc}>Type below, or start from one of these.</div>
            <div className={styles.chips}>
              {SPEECH_SUGGESTIONS.map((s) => (
                <button key={s} type="button" className={styles.chip} onClick={() => setText(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {spoken.map((s) => (
              <div key={s.id} className={styles.turn}>
                <div className={`${styles.turnRole} ${s.audio ? styles.turnRoleAssistant : styles.turnRoleError}`}>
                  {s.audio ? "" : "Error · "}
                  {s.voice} · {s.model}
                </div>
                <div className={styles.turnContent}>{s.input}</div>
                {s.error && <div className={`${styles.turnContent} ${styles.turnContentError}`}>{s.error}</div>}
                {s.audio && (
                  <div className={styles.clipRow}>
                    <audio className={styles.clipAudio} src={s.audio.url} controls />
                  </div>
                )}
                <div className={styles.resultMeta}>
                  <span>{s.seconds.toFixed(1)} s</span>
                  {s.audio && (
                    <>
                      <a className={styles.buttonGhost} href={s.audio.url} download={s.audio.name}>
                        <Icon name="download" /> Download
                      </a>
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        onClick={() => s.audio && transcribeSpoken(s.audio)}
                      >
                        <Icon name="mic" /> Transcribe it
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {speaking && (
              <div className={styles.turn}>
                <div className={`${styles.turnRole} ${styles.turnRoleAssistant}`}>
                  {designing ? "Described voice" : voice || "Default voice"} · {speechModel}
                </div>
                <div className={styles.turnContent}>
                  <span className={styles.dim}>Speaking, which takes 5–15 s</span>
                  <span className={styles.typingCursor} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <form
        onSubmit={speak}
        className={styles.composer}
        onKeyDown={(e) => {
          // Not while an input method is composing: Enter picks the characters.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void speak();
          }
        }}
      >
        {mimoPaused && pausedNotice("MiMo", "mimo")}
        <div className={styles.composerBox}>
          <textarea
            className={styles.chatTextarea}
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            value={text}
            maxLength={MAX_SPEECH_CHARS}
            onChange={(e) => setText(e.target.value)}
            placeholder="Text to speak…"
            disabled={speaking}
          />
          <button type="submit" className={styles.button} disabled={!canSpeak}>
            Speak <Icon name="send" />
          </button>
        </div>
        <div className={styles.runHint}>
          <span>
            {designing && !instructions.trim()
              ? "Describe the voice to create first, on the right"
              : "Enter to speak · Shift+Enter for a new line"}
          </span>
          <span>
            {text.length.toLocaleString()} / {MAX_SPEECH_CHARS.toLocaleString()}
          </span>
        </div>
      </form>
    </div>
  );

  const speakSettings = (
    <>
      <div className={styles.panelGroup}>
        <div className={styles.panelTitle}>Voice</div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="tts-model">
            Model
          </label>
          <select
            id="tts-model"
            className={styles.select}
            value={speechModel}
            onChange={(e) => setSpeechModel(e.target.value)}
          >
            {SPEECH_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {!designing && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="tts-voice">
              Voice
            </label>
            <select id="tts-voice" className={styles.select} value={voice} onChange={(e) => setVoice(e.target.value)}>
              <option value="">Default</option>
              {(voices ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {`${v.id} · ${v.description}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="tts-instructions">
            {designing ? "The voice to create" : "Style"}
          </label>
          <textarea
            id="tts-instructions"
            className={styles.input}
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={designing ? "A warm, low male voice, unhurried" : "Calm, like a radio host"}
          />
        </div>
        {voicesError ? (
          <p className={styles.sidebarHint}>
            Couldn&apos;t list the voices: {voicesError}{" "}
            <button type="button" className={styles.linkButton} onClick={() => setVoicesError(null)}>
              Try again
            </button>
          </p>
        ) : (
          !voices && !designing && <p className={styles.sidebarHint}>Loading voices…</p>
        )}
        <p className={styles.sidebarHint}>
          MiMo Studio&apos;s speech page, through chatgpt-web-gateway. Each one takes 5–15 s and is saved to
          the MiMo account&apos;s history.
        </p>
      </div>

      <div className={styles.panelGroup}>
        <div className={styles.panelTitle}>Results</div>
        <div className={styles.statList}>
          <div className={styles.statListRow}>
            <span>Clips</span>
            <span>{spoken.length}</span>
          </div>
        </div>
        <button type="button" className={styles.buttonGhost} onClick={clearSpoken} disabled={spoken.length === 0}>
          Clear
        </button>
      </div>
    </>
  );

  return (
    <div className={styles.playground}>
      {mode === "transcribe" ? transcribeMain : speakMain}
      <aside className={styles.playgroundSidebar}>
        {mode === "transcribe" ? transcribeSettings : speakSettings}
      </aside>
    </div>
  );
}
