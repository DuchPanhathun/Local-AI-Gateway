import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { defaultModel } from "@/lib/ai-providers";
import { Logo } from "../logo";
import { CodeBlock, CodeTabs, DocsNav, ThemeToggle, type NavGroup } from "./docs-client";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "Docs", // "Docs · Thun Murex", from the layout's title template
  description:
    "How to call the Thun Murex gateway: endpoints, request and response formats, streaming and errors.",
};

const NAV: NavGroup[] = [
  {
    title: "Getting started",
    items: [
      { id: "overview", label: "Overview" },
      { id: "authentication", label: "Authentication" },
      { id: "quickstart", label: "Quickstart" },
    ],
  },
  {
    title: "API reference",
    items: [
      { id: "chat", label: "Chat" },
      { id: "streaming", label: "Streaming" },
      { id: "models", label: "Models" },
      { id: "images", label: "Image generation" },
      { id: "transcribe", label: "Speech to text" },
      { id: "speech", label: "Text to speech" },
      { id: "me", label: "Your key" },
      { id: "usage", label: "Usage" },
      { id: "quotas", label: "Quotas" },
      { id: "providers", label: "Pause & resume" },
      { id: "tokens", label: "Access tokens" },
      { id: "users", label: "Users" },
      { id: "health", label: "CLI health" },
      { id: "limits", label: "CLI plan limits" },
    ],
  },
  {
    title: "Guides",
    items: [
      { id: "conversations", label: "Conversations" },
      { id: "cloud-providers", label: "Cloud providers" },
      { id: "local-clis", label: "Local agent CLIs" },
      { id: "errors", label: "Errors" },
      { id: "vscode", label: "VS Code & phone" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Code samples. {{ORIGIN}} becomes the page's own address in the browser.
// ---------------------------------------------------------------------------

const SETUP = `export AI_THUN_URL="{{ORIGIN}}"
export AI_THUN_KEY="sk-ai-thun-…"   # an access token, or your APP_API_KEY`;

const CHAT_TABS = [
  {
    label: "curl",
    code: `curl "$AI_THUN_URL/api/chat" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "groq",
    "messages": [{"role": "user", "content": "Write a haiku about Phnom Penh"}]
  }'`,
  },
  {
    label: "JavaScript",
    code: `const res = await fetch(\`\${process.env.AI_THUN_URL}/api/chat\`, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.AI_THUN_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    provider: "groq",
    messages: [{ role: "user", content: "Write a haiku about Phnom Penh" }],
  }),
});
const data = await res.json();
if (!res.ok) throw new Error(data.error?.message ?? data.error ?? data.detail);
console.log(data.choices[0].message.content);`,
  },
  {
    label: "Python",
    code: `import os
import requests

res = requests.post(
    f"{os.environ['AI_THUN_URL']}/api/chat",
    headers={"Authorization": f"Bearer {os.environ['AI_THUN_KEY']}"},
    json={
        "provider": "groq",
        "messages": [{"role": "user", "content": "Write a haiku about Phnom Penh"}],
    },
    timeout=300,
)
res.raise_for_status()
print(res.json()["choices"][0]["message"]["content"])`,
  },
];

const CLOUD_RESPONSE = `{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "openai/gpt-oss-120b",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "River light at dawn…" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 82, "completion_tokens": 141, "total_tokens": 223 }
}`;

const LOCAL_RESPONSE = `{
  "id": "local-7352154e-6436-4025-b807-eea57954a1ff",
  "object": "chat.completion",
  "provider": "claude",
  "model": "claude-sonnet-5-5",
  "session_id": "7352154e-6436-4025-b807-eea57954a1ff",
  "duration_ms": 8106,
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": { "role": "assistant", "content": "It's an AI gateway that…" }
    }
  ],
  "usage": { "prompt_tokens": 21480, "completion_tokens": 312, "total_tokens": 21792 }
}`;

const STREAM_OUTPUT = `event: start
data: {"provider":"groq"}

event: thinking
data: {"text":"Just list the numbers."}

event: delta
data: {"text":"1, 2, 3"}

event: delta
data: {"text":", 4, 5"}

event: done
data: {"provider":"groq","model":"openai/gpt-oss-120b","result":"1, 2, 3, 4, 5","finish_reason":"stop","usage":{"prompt_tokens":79,"completion_tokens":38,"total_tokens":117},"duration_ms":412}`;

const STREAM_TABS = [
  {
    label: "curl",
    code: `curl -N "$AI_THUN_URL/api/chat/stream" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "groq", "prompt": "Count from 1 to 5"}'`,
  },
  {
    label: "JavaScript",
    code: `const res = await fetch(\`\${process.env.AI_THUN_URL}/api/chat/stream\`, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.AI_THUN_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ provider: "claude", model: "sonnet", prompt: "What does this project do?" }),
});
if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  throw new Error(err.error ?? err.detail ?? \`HTTP \${res.status}\`);
}

const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  const events = buffer.split("\\n\\n"); // every event ends with a blank line
  buffer = events.pop();
  for (const block of events) {
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null");
    if (event === "delta") process.stdout.write(data.text);
    if (event === "done") console.log("\\n\\nsession:", data.session_id, "tokens:", data.usage);
    if (event === "error") throw new Error(data.detail);
  }
}`,
  },
  {
    label: "Python",
    code: `import json
import os
import requests

with requests.post(
    f"{os.environ['AI_THUN_URL']}/api/chat/stream",
    headers={"Authorization": f"Bearer {os.environ['AI_THUN_KEY']}"},
    json={"provider": "claude", "model": "sonnet", "prompt": "What does this project do?"},
    stream=True,
    timeout=300,
) as res:
    res.raise_for_status()
    event = None
    for raw in res.iter_lines(chunk_size=None):
        line = raw.decode("utf-8")
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            data = json.loads(line[6:])
            if event == "delta":
                print(data["text"], end="", flush=True)
            elif event == "done":
                print("\\n\\nsession:", data.get("session_id"), "tokens:", data.get("usage"))
            elif event == "error":
                raise RuntimeError(data["detail"])`,
  },
];

const MODELS_CURL = `curl "$AI_THUN_URL/api/models" -H "Authorization: Bearer $AI_THUN_KEY"`;

const MODELS_RESPONSE = `{
  "providers": {
    "groq": {
      "kind": "cloud",
      "default": "openai/gpt-oss-120b",
      "models": [{ "id": "openai/gpt-oss-120b", "name": "openai/gpt-oss-120b" }, …],
      "note": null,
      "error": null,
      "paused": false
    },
    "claude": {
      "kind": "local",
      "default": null,
      "models": [{ "id": "sonnet", "name": "Claude Sonnet (latest)" }, …],
      "note": "aliases for the latest model of each family …",
      "error": null,
      "paused": false
    },
    …
  }
}`;

const IMAGE_CURL = `curl "$AI_THUN_URL/api/image" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "A lotus flower, flat vector illustration"}' \\
  | jq -r .image_base64 | base64 -d > lotus.png`;

const IMAGE_RESPONSE = `{
  "provider": "codex",
  "model": null,
  "image_base64": "iVBORw0KGgoAAAANSUhEUgAA…",
  "mime_type": "image/png",
  "message": "Created the lotus on a plain background.",
  "session_id": "01a11183-…",
  "duration_ms": 76000
}`;

const TRANSCRIBE_CURL = `curl "$AI_THUN_URL/api/transcribe" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -F file=@meeting.m4a \\
  -F language=en`;

const TRANSCRIBE_RESPONSE = `{ "text": " Let's start with the budget.", "x_groq": { "id": "req_…" } }`;

const SPEECH_CURL = `curl "$AI_THUN_URL/api/speech" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"input": "Good evening!", "voice": "Dean", "instructions": "Calm, like a radio host."}' \\
  -o evening.wav`;

const USAGE_CURL = `curl "$AI_THUN_URL/api/usage?month=2026-10" -H "Authorization: Bearer $APP_API_KEY"`;

const USAGE_RESPONSE = `{
  "month": "2026-10",
  "months": ["2026-10", "2026-09"],
  "totals": {
    "requests": 31,
    "errors": 0,
    "promptTokens": 122819,
    "completionTokens": 12995,
    "totalTokens": 135814
  },
  "models": [
    {
      "provider": "claude",
      "model": "claude-haiku-5-5",
      "requests": 9,
      "errors": 0,
      "promptTokens": 54753,
      "completionTokens": 404,
      "totalTokens": 55157,
      "tokensReported": true,
      "avgDurationMs": 3900,
      "timed": 9,
      "lastUsedAt": "2026-10-15T15:03:13.000Z"
    },
    …
  ],
  "days": [
    { "day": "2026-10-01", "requests": 0, "totalTokens": 0 },
    …
  ],
  "generatedAt": "2026-10-16T02:30:00.000Z"
}`;

const QUOTAS_CURL = `curl "$AI_THUN_URL/api/quotas" -H "Authorization: Bearer $APP_API_KEY"`;

const QUOTAS_RESPONSE = `{
  "keys": [
    {
      "provider": "groq",
      "keyName": "GROQ_API_KEY3",
      "model": "openai/gpt-oss-120b",
      "requestsLast60s": 1,
      "tokensLast60s": 127,
      "requestsToday": 12,
      "tokensToday": 48210,
      "limits": { "tokensPerDay": 500000 }
    },
    …
  ],
  "local": [
    {
      "provider": "claude",
      "model": "claude-sonnet-5-5",
      "requestsToday": 4,
      "errorsToday": 0,
      "promptTokensToday": 86020,
      "completionTokensToday": 1210,
      "tokensToday": 87230,
      "tokensReported": true,
      "avgDurationMs": 8100,
      "finishedToday": 4,
      "lastUsedAt": "2026-10-16T02:11:40.000Z"
    }
  ],
  "paused": ["cerebras", "codex"],
  "generatedAt": "2026-10-16T02:30:00.000Z"
}`;

const PAUSE_CURL = `curl -X PATCH "$AI_THUN_URL/api/providers" \\
  -H "Authorization: Bearer $APP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "cerebras", "paused": true}'

# → {"paused": ["cerebras"]}`;

const TOKENS_CURL = `# Create one: 1M tokens and 1,000 requests a month, 20 a minute, until the end
# of Nov 30 (UTC), Groq and Cerebras only. The key is shown only in this response.
curl -X POST "$AI_THUN_URL/api/tokens" \\
  -H "Authorization: Bearer $APP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Dara", "note": "paid 5 USD on Oct 26",
       "limits": {"period": "month", "tokens": 1000000, "requests": 1000, "perMinute": 20},
       "expiresAt": "2026-11-30", "providers": ["groq", "cerebras"]}'
# → {"id": "9f2c41d07ab35e18", "token": "sk-ai-thun-3f9a…", "name": "Dara", "status": "active", …}

# List them, with each one's status and use this period
curl "$AI_THUN_URL/api/tokens" -H "Authorization: Bearer $APP_API_KEY"

# One key's use in a month, by day and model
curl "$AI_THUN_URL/api/tokens?id=9f2c41d07ab35e18&month=2026-10" -H "Authorization: Bearer $APP_API_KEY"

# Top it up, give it 30 more days, turn it off, or make it a new secret
curl -X PATCH "$AI_THUN_URL/api/tokens?id=9f2c41d07ab35e18" \\
  -H "Authorization: Bearer $APP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"addTokens": 500000, "extendDays": 30}'
#    -d '{"disabled": true}'   or   -d '{"rotate": true}'   (the new key comes back in "token")

# Delete one
curl -X DELETE "$AI_THUN_URL/api/tokens?id=9f2c41d07ab35e18" \\
  -H "Authorization: Bearer $APP_API_KEY"
# → {"revoked": "9f2c41d07ab35e18"}`;

const ME_CURL = `curl "$AI_THUN_URL/api/me" -H "Authorization: Bearer $AI_THUN_KEY"`;

const ME_RESPONSE = `{
  "name": "Dara",
  "hint": "sk-ai-thun-3f9a…9c1e",
  "status": "active",
  "expiresAt": "2026-11-30T23:59:59.999Z",
  "limits": { "period": "month", "tokens": 1000000, "requests": 1000, "perMinute": 20 },
  "providers": ["groq", "cerebras"],
  "used": { "requests": 212, "errors": 3, "tokens": 412880, "estimatedTokens": 0 },
  "remaining": { "tokens": 587120, "requests": 791 },
  "resetsAt": "2026-11-01T00:00:00.000Z",
  "total": { "requests": 212, "errors": 3, "tokens": 412880, "estimatedTokens": 0 },
  …
}`;

const HEALTH_RESPONSE = `{
  "status": "ok",
  "providers": {
    "claude": {
      "installed": true,
      "path": "/home/thun/.nvm/versions/node/v24.22.0/bin/claude",
      "version": "2.1.300 (Claude Code)",
      "supports_resume": true,
      "supports_images": false,
      "supports_no_tools": true
    },
    …
  }
}`;

const LIMITS_RESPONSE = `{
  "providers": {
    "antigravity": {
      "installed": true,
      "supported": true,
      "checked_at": "2026-10-24T10:24:36Z",
      "error": null,
      "limits": [
        {
          "id": "gemini-5h",
          "window": "5h",
          "remaining_fraction": 0.92,
          "resets_at": "2026-10-24T14:08:32Z",
          "name": "Five Hour Limit Remaining",
          "group": "Gemini Models",
          "models": "Gemini Flash, Gemini Pro"
        },
        …
      ]
    },
    "claude": {
      "installed": true,
      "supported": true,
      "limits": [
        {
          "id": "five_hour",
          "window": "5h",
          "remaining_fraction": 0.93,
          "resets_at": "2026-10-24T23:50:00+07:00",
          "name": "Current session",
          "group": null,
          "models": null
        },
        { "id": "seven_day", "window": "weekly", "remaining_fraction": 0.16, … }
      ],
      …
    },
    "codex": { "installed": true, "supported": false, "limits": [], … },
    …
  }
}`;

const CLOUD_CONVERSATION = `curl "$AI_THUN_URL/api/chat" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "sea-lion",
    "messages": [
      {"role": "system", "content": "Answer in one short sentence."},
      {"role": "user", "content": "What is the capital of Cambodia?"},
      {"role": "assistant", "content": "Phnom Penh is the capital of Cambodia."},
      {"role": "user", "content": "How many people live there?"}
    ]
  }'`;

const LOCAL_CONVERSATION = `# The first answer includes a session_id …
curl "$AI_THUN_URL/api/chat" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "claude",
    "model": "sonnet",
    "prompt": "What does this project do?",
    "workdir": "/home/thun/Desktop/documents/Project/ai-thun"
  }'

# … send it back, with the same workdir, to carry on the conversation
curl "$AI_THUN_URL/api/chat" \\
  -H "Authorization: Bearer $AI_THUN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "claude",
    "session_id": "7352154e-6436-4025-b807-eea57954a1ff",
    "prompt": "How is it deployed?",
    "workdir": "/home/thun/Desktop/documents/Project/ai-thun"
  }'`;

const ERROR_BODY = `{ "error": "Provider \\"cerebras\\" is paused. Resume it on the Manage page of the Thun Murex console." }`;

const LIMIT_BODY = `HTTP/1.1 429 Too Many Requests
Retry-After: 7140

{
  "detail": "claude exited with status 1: You've hit your limit · resets 3pm (Asia/Bangkok)",
  "retry_after": 7140
}`;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className={styles.section}>
      <h2 className={styles.h2}>
        <a href={`#${id}`} className={styles.anchor}>
          {title}
        </a>
      </h2>
      {children}
    </section>
  );
}

const METHOD_CLASS = {
  GET: styles.methodGet,
  POST: styles.methodPost,
  PATCH: styles.methodPatch,
  DELETE: styles.methodDelete,
};

function Endpoint({
  method,
  path,
  owner,
}: {
  method: keyof typeof METHOD_CLASS;
  path: string;
  owner?: boolean;
}) {
  return (
    <div className={styles.endpoint}>
      <span className={`${styles.method} ${METHOD_CLASS[method]}`}>{method}</span>
      <span className={styles.path}>{path}</span>
      <span className={styles.auth}>{owner ? "Owner key only" : "Owner key or access token"}</span>
    </div>
  );
}

// [name, type, description, required?]
type Field = [string, string, ReactNode, boolean?];

function Fields({ rows, nameLabel = "Field" }: { rows: Field[]; nameLabel?: string }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{nameLabel}</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, type, description, required]) => (
            <tr key={name}>
              <td className={styles.fieldName}>
                <code>{name}</code>
                {required && <span className={styles.required}>required</span>}
              </td>
              <td className={styles.type}>{type}</td>
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Yes = () => <span className={styles.yes}>Yes</span>;
const No = () => <span className={styles.no}>—</span>;

function Note({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <div className={`${styles.note} ${warn ? styles.noteWarn : ""}`}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DocumentsPage() {
  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/documents" className={styles.brand}>
          <Logo className={styles.brandMark} />
          Thun Murex
          <span className={styles.brandTag}>Docs</span>
        </Link>
        <div className={styles.topActions}>
          <Link href="/" className={styles.topLink}>
            Console →
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <DocsNav groups={NAV} />
        </aside>

        <main className={styles.main}>
          <details className={styles.mobileToc}>
            <summary>Contents</summary>
            <div className={styles.mobileTocBody}>
              {NAV.map((g) => (
                <div key={g.title}>
                  <div className={styles.navGroupTitle}>{g.title}</div>
                  {g.items.map((item) => (
                    <a key={item.id} href={`#${item.id}`} className={styles.navLink}>
                      {item.label}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </details>

          <div className={styles.eyebrow}>Documentation</div>
          <h1 className={styles.title}>Thun Murex API</h1>
          <p className={styles.lead}>
            One endpoint for three cloud AI providers and four AI coding tools running on this
            machine. Send the same JSON to any of them, and every answer comes back in the same
            shape.
          </p>

          {/* ------------------------------------------------------------ */}

          <Section id="overview" title="Overview">
            <p>
              Thun Murex is a gateway running on <code>thun-latitude-7280</code>. Apps send it one
              kind of request, and it answers from any of seven providers: three cloud APIs, and
              four coding CLIs (command-line AI tools) running on the machine itself.
            </p>
            <p>
              Requests and responses are JSON in the OpenAI chat format, so most OpenAI-style code
              works once you change the address and the key. The gateway can only be reached from
              devices on your Tailscale network.
            </p>
            <Table
              head={["Provider", "provider value", "Kind", "Default model"]}
              rows={[
                ["SEA-LION", <code key="v">sea-lion</code>, "Cloud API", <code key="m">{defaultModel("sea-lion")}</code>],
                ["Cerebras", <code key="v">cerebras</code>, "Cloud API", <code key="m">{defaultModel("cerebras")}</code>],
                ["Groq", <code key="v">groq</code>, "Cloud API", <code key="m">{defaultModel("groq")}</code>],
                ["Claude Code", <code key="v">claude</code>, "Local CLI", <span key="m" className={styles.muted}>The CLI’s own default</span>],
                ["Codex", <code key="v">codex</code>, "Local CLI", <span key="m" className={styles.muted}>The CLI’s own default</span>],
                ["Gemini CLI", <code key="v">gemini</code>, "Local CLI", <span key="m" className={styles.muted}>The CLI’s own default</span>],
                ["Antigravity", <code key="v">antigravity</code>, "Local CLI", <span key="m" className={styles.muted}>The CLI’s own default</span>],
                ["ChatGPT (web)", <code key="v">chatgpt</code>, "Website", <code key="m">auto</code>],
                ["Grok (web)", <code key="v">grok</code>, "Website", <code key="m">fast</code>],
                ["MiMo (web)", <code key="v">mimo</code>, "Website", <code key="m">mimo-v2.6-pro</code>],
              ]}
            />
            <p>
              Leave <code>provider</code> out and the request goes to SEA-LION. To see every model
              you can choose, call <a href="#models">GET /api/models</a>.
            </p>
          </Section>

          <Section id="authentication" title="Authentication">
            <p>
              Every request needs a key in the <code>Authorization</code> header:
            </p>
            <CodeBlock code={`Authorization: Bearer <your key>`} label="Header" />
            <p>There are two kinds of key:</p>
            <ul>
              <li>
                <strong>Owner key</strong> (<code>APP_API_KEY</code>): can call every endpoint and
                sign in to the console. Keep it to yourself.
              </li>
              <li>
                <strong>Access tokens</strong> (<code>sk-ai-thun-…</code>): created on the
                console’s <Link href="/">API keys</Link> page, one per app or person, or by
                people with an account on their own <Link href="/account">account page</Link>.
                They can only send requests to providers and read their own balance at{" "}
                <a href="#me">/api/me</a>. Each one has limits, an expiry date and providers:
                its own, or for an account’s keys, the account’s plan, which they all share.
              </li>
            </ul>
            <Table
              head={["Endpoint", "Owner key", "Access token"]}
              rows={[
                [<code key="e">POST /api/chat, /api/chat/stream</code>, <Yes key="o" />, <Yes key="t" />],
                [<code key="e">POST /api/image, /api/transcribe, /api/speech</code>, <Yes key="o" />, <Yes key="t" />],
                [<code key="e">GET /api/models, /api/speech, /api/me</code>, <Yes key="o" />, <Yes key="t" />],
                [<code key="e">GET /api/usage, /api/quotas</code>, <Yes key="o" />, <No key="t" />],
                [<code key="e">GET, PATCH /api/providers</code>, <Yes key="o" />, <No key="t" />],
                [<code key="e">GET, POST, PATCH, DELETE /api/tokens</code>, <Yes key="o" />, <No key="t" />],
                [<code key="e">GET, PATCH /api/users</code>, <Yes key="o" />, <No key="t" />],
                [<code key="e">GET /api/local-agent/health, /api/local-agent/limits</code>, <Yes key="o" />, <No key="t" />],
              ]}
            />
            <p>
              A missing or wrong key gets <code>401</code> with{" "}
              <code>{`{"error": "Unauthorized"}`}</code>. Keys are secrets: call the gateway from
              your own server or scripts, not from code that runs in someone’s web browser.
            </p>
            <ul>
              <li>
                <strong>Wrong keys lock you out for a while.</strong> After 10 wrong keys in 10
                minutes from one address, every request from there gets <code>429</code> for 15
                minutes, with a <code>Retry-After</code> header, even with the right key.
              </li>
              <li>
                <strong>The console</strong> sends your owner key once, to sign in. The browser then
                keeps a sign-in cookie for 7 days, which the page’s scripts can’t read, never the
                key itself. A new <code>APP_API_KEY</code> signs everyone out.
              </li>
            </ul>
          </Section>

          <Section id="quickstart" title="Quickstart">
            <p>
              <strong>1.</strong> Put the gateway’s address and your key in two variables. The
              examples on this page use them.
            </p>
            <CodeBlock code={SETUP} label="Shell" />
            <p>
              <strong>2.</strong> Send a message:
            </p>
            <CodeTabs tabs={CHAT_TABS} />
            <p>
              <strong>3.</strong> The answer is in <code>choices[0].message.content</code>:
            </p>
            <CodeBlock code={CLOUD_RESPONSE} label="Response (shortened)" />
          </Section>

          {/* ------------------------------------------------------------ */}

          <Section id="chat" title="Chat">
            <Endpoint method="POST" path="/api/chat" />
            <p>
              Sends a message or a whole conversation to any provider and returns the complete
              answer as one JSON response. For text that appears while it’s being written, use{" "}
              <a href="#streaming">/api/chat/stream</a> with the same body.
            </p>
            <h3 className={styles.h3}>Request body</h3>
            <Fields
              rows={[
                ["provider", "string", <>Which provider answers: <code>sea-lion</code>, <code>cerebras</code>, <code>groq</code>, <code>claude</code>, <code>codex</code>, <code>gemini</code> or <code>antigravity</code>. Default <code>sea-lion</code>.</>],
                ["model", "string", <>A model id from <a href="#models">GET /api/models</a>. Default: the provider’s default model.</>],
                ["messages", "array", <>The conversation so far: <code>{`[{"role", "content"}]`}</code> with roles <code>system</code>, <code>user</code> and <code>assistant</code>. Send this or <code>prompt</code>.</>],
                ["prompt", "string", <>One user message: a shorter way to send <code>messages</code> with a single message in it.</>],
                ["session_id", "string", <>Local CLIs: carry on an earlier conversation, using the <code>session_id</code> from its answer. See <a href="#conversations">Conversations</a>.</>],
                ["workdir", "string", <>Local CLIs: the folder the CLI works in, as an absolute path inside the folders the gateway allows. Default: the gateway’s default folder.</>],
                ["no_tools", "boolean", <>Local CLIs, <code>claude</code> and <code>codex</code> only: run the CLI with none of its tools (no files, shell or web), as a plain model.</>],
                ["max_tokens, temperature, …", "", <>Cloud APIs: any other OpenAI field (<code>top_p</code>, <code>stop</code>, <code>response_format</code>, <code>reasoning_effort</code>, …) goes to the provider unchanged. Local CLIs ignore them.</>],
                ["chat_template_kwargs", "object", <>SEA-LION: <code>{`{"enable_thinking": false}`}</code> turns its reasoning off, for much faster answers.</>],
              ]}
            />
            <h3 className={styles.h3}>Response</h3>
            <p>
              Cloud APIs answer in their own OpenAI format, passed on unchanged (see the{" "}
              <a href="#quickstart">Quickstart</a>). Local CLI answers are converted to the same
              shape, with <code>session_id</code> and <code>duration_ms</code> added.{" "}
              <code>usage</code> is <code>null</code> for Codex and Gemini CLI, which don’t report
              tokens.
            </p>
            <CodeBlock code={LOCAL_RESPONSE} label="Response from a local CLI" />
          </Section>

          <Section id="streaming" title="Streaming">
            <Endpoint method="POST" path="/api/chat/stream" />
            <p>
              Takes the same body as <a href="#chat">/api/chat</a>, and sends the answer as{" "}
              <a href="https://developer.mozilla.org/docs/Web/API/Server-sent_events">
                Server-Sent Events
              </a>{" "}
              while it’s being written. Every provider sends the same events:
            </p>
            <Table
              head={["Event", "Data", "Meaning"]}
              rows={[
                [<code key="e">start</code>, <code key="d">{`{"provider"}`}</code>, "The provider has started on the request."],
                [<code key="e">thinking</code>, <code key="d">{`{"text"}`}</code>, "Reasoning, as it’s generated. Only from cloud models that think before answering (SEA-LION, gpt-oss)."],
                [<code key="e">delta</code>, <code key="d">{`{"text"}`}</code>, "The next piece of the answer."],
                [<code key="e">done</code>, <code key="d">{`{"provider", "model", "result", "finish_reason", "usage", "duration_ms"}`}</code>, <>The whole answer is in <code>result</code>. Local CLIs add <code>session_id</code> and leave out <code>finish_reason</code>. Always the last event.</>],
                [<code key="e">error</code>, <code key="d">{`{"status", "detail", …}`}</code>, <>The request failed after the stream started, with the same fields as an <a href="#errors">error response</a>. Always the last event.</>],
              ]}
            />
            <CodeBlock code={STREAM_OUTPUT} label="What the stream looks like" />
            <CodeTabs tabs={STREAM_TABS} />
            <ul>
              <li>
                While nothing new comes for 20 seconds (a CLI at work), the stream sends a
                comment line, <code>: keep-alive</code>, so nothing between you and the gateway
                closes it. Skip lines that start with <code>:</code>, as SSE readers do.
              </li>
              <li>
                A problem found before the stream starts (a wrong key, an unknown provider, a
                paused provider, a provider’s own error such as <code>402</code>) comes back as an
                ordinary JSON error response, not as a stream.
              </li>
              <li>
                Closing the connection stops the work: a cloud request is cancelled, and a local
                CLI is stopped.
              </li>
              <li>
                <code>{`finish_reason: "length"`}</code> means <code>max_tokens</code> ran out.
                Thinking models can use it all on reasoning and leave <code>result</code> empty:
                raise <code>max_tokens</code>, or for SEA-LION turn thinking off.
              </li>
            </ul>
          </Section>

          <Section id="models" title="Models">
            <Endpoint method="GET" path="/api/models" />
            <p>Lists every provider’s models, with its default and whether it’s paused.</p>
            <CodeBlock code={MODELS_CURL} label="Request" />
            <CodeBlock code={MODELS_RESPONSE} label="Response (shortened)" />
            <Fields
              nameLabel="Provider field"
              rows={[
                ["kind", "string", <><code>cloud</code> or <code>local</code>.</>],
                ["default", "string | null", <>The model used when a request names none. <code>null</code>: the CLI’s own default.</>],
                ["models", "array", <>Each model’s <code>id</code> (the value for <code>model</code>) and <code>name</code>.</>],
                ["note", "string | null", "Extra advice about the list, from the CLI."],
                ["error", "string | null", "Why the list couldn’t be fetched, if it couldn’t."],
                ["paused", "boolean", <>Paused providers turn requests away. See <a href="#providers">Pause &amp; resume</a>.</>],
              ]}
            />
            <p>
              Cloud lists come live from each provider, keep only chat models, and are cached for 10
              minutes. Gemini CLI can’t list its models, so its list is empty and any model name is
              passed through. A paused cloud provider lists only its default model.
            </p>
          </Section>

          <Section id="images" title="Image generation">
            <Endpoint method="POST" path="/api/image" />
            <p>
              Codex draws one image with its built-in image tool, using its ChatGPT sign-in (no API
              key). One image takes about 75 seconds.
            </p>
            <Fields
              rows={[
                ["prompt", "string", "What to draw.", true],
                ["images", "array", <>Up to 5 pictures to edit or follow, in order: <code>{`{"data_base64", "label"}`}</code>. PNG, JPEG or WebP, at most 20 MB each. <code>label</code> says what each one is for, e.g. <code>style reference</code>.</>],
                ["model", "string", "The Codex model that drives the image tool."],
                ["workdir", "string", "As for chat."],
              ]}
            />
            <CodeBlock code={IMAGE_CURL} label="Request: saves the image as lotus.png" />
            <CodeBlock code={IMAGE_RESPONSE} label="Response" />
          </Section>

          <Section id="transcribe" title="Speech to text">
            <Endpoint method="POST" path="/api/transcribe" />
            <p>
              Turns audio into text with Groq’s Whisper, using the Groq keys. It takes the same
              form as OpenAI’s <code>/audio/transcriptions</code>, so OpenAI-compatible clients
              only need the address and key changed. Send <code>multipart/form-data</code>:
            </p>
            <Fields
              rows={[
                ["file", "file", "The audio.", true],
                ["model", "string", <>Default <code>whisper-large-v3-turbo</code>, the fastest.</>],
                ["language", "string", <>The spoken language, e.g. <code>en</code>. Optional, but it helps.</>],
                ["prompt", "string", "Words or spellings to expect."],
                ["response_format", "string", <><code>json</code> (default), <code>verbose_json</code> or <code>text</code>.</>],
                ["temperature", "number", "As in OpenAI’s API."],
                ["provider", "string", <><code>groq</code> (default) or <code>mimo</code>: MiMo Studio’s MiMo-V2.5-ASR, below.</>],
              ]}
            />
            <CodeBlock code={TRANSCRIBE_CURL} label="Request" />
            <CodeBlock code={TRANSCRIBE_RESPONSE} label="Response" />
            <p>
              With <code>provider=mimo</code> the file goes to MiMo Studio’s speech recognition page
              through chatgpt-web-gateway instead (noisy audio, several speakers, dialects; up to 10 MB
              and 90 seconds), and the answer is{" "}
              <code>{`{"provider": "mimo", "model": "mimo-v2.5-asr", "text": "…"}`}</code>. Its other
              fields are ignored, and pausing MiMo pauses it.
            </p>
            <p>
              Groq allows 20 transcriptions a minute and 2,000 a day per key. A key that’s at its
              limit is skipped for the next one; if every key is, the answer is <code>429</code>{" "}
              with a <code>Retry-After</code> header. Pausing Groq pauses this endpoint too.
            </p>
          </Section>

          <Section id="speech" title="Text to speech">
            <Endpoint method="POST" path="/api/speech" />
            <p>
              Speaks text through MiMo Studio’s speech pages, via chatgpt-web-gateway. It takes JSON
              like OpenAI’s <code>/audio/speech</code> and answers with the audio file (WAV, 24 kHz
              mono). <code>GET /api/speech</code> lists the models and voices.
            </p>
            <Fields
              rows={[
                ["input", "string", "The text, up to 1,024 characters.", true],
                ["model", "string", <><code>mimo-v2.5-tts</code> (default): one of its voices. <code>mimo-v2.5-tts-voicedesign</code>: a voice you describe. <code>mimo-v2.5-tts-voiceclone</code>: the voice of a recording.</>],
                ["voice", "string", <>For <code>mimo-v2.5-tts</code>: Bingtang (冰糖, default), Mia, Moli (茉莉), Chloe, Suda (苏打), Milo, Baihua (白桦) or Dean.</>],
                ["instructions", "string", "The speaking style, or for voicedesign the voice to create."],
                ["reference_audio_base64", "string", "For voiceclone: a 5–30 s recording under 10 MB, base64-encoded."],
                ["voice_consent", "boolean", <>For voiceclone, required <code>true</code>: ticks MiMo’s consent to uploading the recording’s voiceprint. Only copy voices you have the right to use.</>],
                ["response_format", "string", <><code>json</code> answers the audio base64-encoded, with its type and voice, instead of the file.</>],
              ]}
            />
            <CodeBlock code={SPEECH_CURL} label="Request: saves the audio as evening.wav" />
            <p>
              The file’s response carries <code>X-Model</code>, <code>X-Voice</code> (URL-encoded) and{" "}
              <code>X-Duration-Ms</code> headers. Each takes about 5–15 seconds, and speech, MiMo
              transcription and MiMo chat take turns on one MiMo tab. Every one is saved to the MiMo
              account’s history; pausing MiMo pauses this endpoint.
            </p>
          </Section>

          <Section id="me" title="Your key">
            <Endpoint method="GET" path="/api/me" />
            <p>
              The access token you call with: its status (<code>active</code>,{" "}
              <code>disabled</code>, <code>expired</code> or <code>limited</code>), its limits, what
              it has used and has left this period, when the period starts over, and when the key
              expires. It answers even for a key that’s turned off, expired or used up, so you can
              see why requests are refused. With the owner key it answers{" "}
              <code>{`{"owner": true}`}</code>.
            </p>
            <CodeBlock code={ME_CURL} label="Request" />
            <CodeBlock code={ME_RESPONSE} label="Response (shortened)" />
            <ul>
              <li>
                <code>period</code> is <code>day</code> or <code>month</code> (UTC), or{" "}
                <code>total</code> for a prepaid amount that doesn’t start over.{" "}
                <code>null</code> means no limit, and <code>providers: null</code> means every
                provider.
              </li>
              <li>
                Failed requests (<code>errors</code>) don’t count against the limit. Tokens are
                what the provider reported; where it doesn’t say (the web chats, Codex, Gemini
                CLI), they’re estimated from the prompt’s and answer’s length, about 4 characters a
                token, and counted in <code>estimatedTokens</code> too. Speech, transcription and
                images count as requests only.
              </li>
            </ul>
          </Section>

          <Section id="usage" title="Usage">
            <Endpoint method="GET" path="/api/usage?month=YYYY-MM" owner />
            <p>
              One month’s usage across every provider: totals, every model with its requests and
              tokens (most tokens first), and a total for each day. <code>month</code> defaults to
              the current one. This is what the console’s Monthly usage panel shows.
            </p>
            <CodeBlock code={USAGE_CURL} label="Request" />
            <CodeBlock code={USAGE_RESPONSE} label="Response (shortened)" />
            <ul>
              <li>
                Days are UTC days. <code>months</code> lists the months that have usage.
              </li>
              <li>
                <code>tokensReported: false</code> means none of that model’s requests said how
                many tokens they used (Codex, Gemini CLI, Whisper), so its zeros mean
                “unknown”.
              </li>
              <li>
                Usage is saved on the server, so restarts and updates don’t reset it. It’s kept for
                about 13 months.
              </li>
            </ul>
          </Section>

          <Section id="quotas" title="Quotas">
            <Endpoint method="GET" path="/api/quotas" owner />
            <p>
              Today’s usage in detail: every cloud API key with its last-minute and daily numbers
              next to the provider’s published limits, every local CLI and model used today, and
              the paused providers. This is what the console’s Analytics page shows.
            </p>
            <CodeBlock code={QUOTAS_CURL} label="Request" />
            <CodeBlock code={QUOTAS_RESPONSE} label="Response (shortened)" />
            <p>
              Keys are shown by the name of the setting that holds them, never by their value.
              The last-minute numbers start again from zero when the server restarts; the daily
              ones don’t.
            </p>
          </Section>

          <Section id="providers" title="Pause & resume">
            <Endpoint method="GET" path="/api/providers" owner />
            <Endpoint method="PATCH" path="/api/providers" owner />
            <p>
              A paused provider turns every request away with <code>503</code>, from the console
              and from access tokens alike, until you resume it. Its keys and CLI sign-in stay as
              they are. Pausing Groq also pauses <a href="#transcribe">speech to text</a>, and
              pausing Codex pauses <a href="#images">image generation</a>. You can also do this on
              the console’s Manage page.
            </p>
            <Fields
              rows={[
                ["provider", "string", "Which provider to change.", true],
                ["paused", "boolean", <><code>true</code> to pause, <code>false</code> to resume.</>, true],
              ]}
            />
            <CodeBlock code={PAUSE_CURL} label="Pause Cerebras" />
            <p>
              Both calls return the providers that are paused now, as{" "}
              <code>{`{"paused": [...]}`}</code>.
            </p>
          </Section>

          <Section id="tokens" title="Access tokens">
            <Endpoint method="GET" path="/api/tokens" owner />
            <Endpoint method="POST" path="/api/tokens" owner />
            <Endpoint method="PATCH" path="/api/tokens?id=…" owner />
            <Endpoint method="DELETE" path="/api/tokens?id=…" owner />
            <p>
              Make, change and delete the keys other apps and people use instead of your owner
              key, and read what each one has used. Changes take effect on the next request. The
              console’s API keys page does the same. Only a hash of each key is stored, so a lost
              key can’t be shown again: give it a new secret instead.
            </p>
            <Fields
              rows={[
                ["name", "string", "Who or what it’s for."],
                ["note", "string", "Your own note (contact, plan, payment). The key’s holder never sees it."],
                ["limits.period", "string", <><code>month</code> (default) or <code>day</code>, UTC, or <code>total</code>: a prepaid amount that doesn’t start over.</>],
                ["limits.tokens", "number", <>Tokens per period. <code>null</code> (default): no limit.</>],
                ["limits.requests", "number", <>Requests per period; failed ones don’t count. <code>null</code>: no limit.</>],
                ["limits.perMinute", "number", <>Requests in any 60 seconds. <code>null</code>: no limit.</>],
                ["expiresAt", "string", <>When it stops working. A date (<code>2026-11-30</code>) means the end of that day, UTC. <code>null</code>: never.</>],
                ["providers", "string[]", <>The providers it can use. <code>null</code> (default): all of them.</>],
                ["agentTools", "boolean", <>Default <code>false</code>: Claude Code and Codex answer without their tools, in the gateway’s own folder, and Gemini CLI, Antigravity and <code>/api/image</code> are refused. <code>true</code> lets the CLIs read files on the machine, in a <code>workdir</code> the caller picks. Only for keys you’d trust with that.</>],
                ["disabled", "boolean", "PATCH: turn it off (true) or on again."],
                ["addTokens, addRequests", "number", "PATCH: raise the limit by this much (a top-up)."],
                ["extendDays", "number", "PATCH: move the expiry this many days later, from now if it’s already past."],
                ["rotate", "boolean", <>PATCH: a new secret, sent back in <code>token</code>. The old one stops working; limits and usage stay.</>],
              ]}
            />
            <CodeBlock code={TOKENS_CURL} label="Requests" />
          </Section>

          <Section id="users" title="Users">
            <Endpoint method="GET" path="/api/users" owner />
            <Endpoint method="PATCH" path="/api/users?id=…" owner />
            <p>
              The people who signed up at <Link href="/account">/account</Link> (with Supabase),
              each with their account: its plan, how many keys it has, and what it has used. A new
              account is <code>pending</code> and its keys don’t work until you activate it.{" "}
              <code>GET /api/users?id=…&amp;month=2026-10</code> adds the user’s keys and that
              month’s use by day and model. The console’s Users page does the same.
            </p>
            <Fields
              rows={[
                ["activate", "boolean", <><code>true</code>: the account’s keys can work. Send it with the plan.</>],
                ["limits, expiresAt, providers, agentTools, disabled, note", "", <>The account’s plan, which all its keys share: the same fields as an access token’s (see <a href="#tokens">Access tokens</a>), and <code>addTokens</code>, <code>addRequests</code>, <code>extendDays</code>.</>],
                ["maxKeys", "number", "How many keys the user may make. Default 5."],
                ["confirmEmail", "boolean", <><code>true</code>: confirm their email address, when Supabase’s email didn’t reach them.</>],
              ]}
            />
          </Section>

          <Section id="health" title="CLI health">
            <Endpoint method="GET" path="/api/local-agent/health" owner />
            <p>
              Which coding CLIs are installed on the machine, their versions, and what each one
              supports. Installed doesn’t mean signed in: each CLI needs its own sign-in on the
              machine.
            </p>
            <CodeBlock code={HEALTH_RESPONSE} label="Response (shortened)" />
          </Section>

          <Section id="limits" title="CLI plan limits">
            <Endpoint method="GET" path="/api/local-agent/limits" owner />
            <p>
              How much of each CLI subscription’s usage limits is left, and when each one is
              fully available again, as the CLI itself reports it. Checking uses none of it. Only
              CLIs that can say are filled in (Claude Code and Antigravity); the others have{" "}
              <code>supported: false</code>. The limits belong to the account, so use outside Thun
              Murex counts too. They refill in rolling windows (<code>5h</code>,{" "}
              <code>weekly</code>), not daily. Claude Code’s 5-hour session has no{" "}
              <code>resets_at</code> until it starts; Antigravity keeps separate limits for its
              Gemini models and for its Claude and GPT models. Answers are cached for a few
              minutes; a signed-out CLI comes back with <code>error</code> set.
            </p>
            <CodeBlock code={LIMITS_RESPONSE} label="Response (shortened)" />
          </Section>

          {/* ------------------------------------------------------------ */}

          <Section id="conversations" title="Conversations">
            <p>
              <strong>Cloud APIs</strong> don’t remember anything between requests. To carry on a
              conversation, send all of it in <code>messages</code> every time, including the
              earlier answers:
            </p>
            <CodeBlock code={CLOUD_CONVERSATION} label="Cloud API: send the whole conversation" />
            <p>
              <strong>Local CLIs</strong> keep their own history. Every answer has a{" "}
              <code>session_id</code>; send it back with the next message, and the same{" "}
              <code>workdir</code>, to carry on. If you send <code>messages</code> to a CLI, only
              the last user message is used.
            </p>
            <CodeBlock code={LOCAL_CONVERSATION} label="Local CLI: send the session_id back" />
          </Section>

          <Section id="cloud-providers" title="Cloud providers">
            <p>
              Each cloud provider has several API keys. Requests take turns across all of them, so
              together they handle many more requests than one key could. A key that answers{" "}
              <code>429</code> (rate limited) is skipped for the next one; if every key is, the
              request fails with <code>429</code>, and its <code>Retry-After</code> header says how
              many seconds until the first key can be used again, when the provider said.
            </p>
            <Table
              head={["Provider", "Limits", "Good to know"]}
              rows={[
                ["SEA-LION", "10 requests a minute per key", <>Thinks before answering, shown as <code>thinking</code> events. Turn it off with <code>{`"chat_template_kwargs": {"enable_thinking": false}`}</code>.</>],
                ["Cerebras", "Different for each model", "Very fast. The account needs billing set up, or it answers 402."],
                ["Groq", "500,000 tokens a day per key and model (our own limit)", <>When a key reaches it, the next key is used until the UTC day ends; when every key has, requests get <code>429</code> until then. <code>gpt-oss</code> models send <code>thinking</code> events.</>],
              ]}
            />
          </Section>

          <Section id="local-clis" title="Local agent CLIs">
            <p>
              <code>claude</code>, <code>codex</code>, <code>gemini</code> and{" "}
              <code>antigravity</code> are real AI coding tools running on the machine, started for
              each request by local-agent-gateway. They work in the <code>workdir</code> folder:
              by default they can read the files there, but not change them or run commands.
            </p>
            <Table
              head={["CLI", "Sessions", "no_tools", "Images", "Reports tokens", "Models"]}
              rows={[
                ["Claude Code", <Yes key="s" />, <Yes key="n" />, <No key="i" />, <Yes key="t" />, <><code>fable</code>, <code>opus</code>, <code>sonnet</code>, <code>haiku</code>, or a full <code>claude-…</code> name</>],
                ["Codex", <Yes key="s" />, <Yes key="n" />, <Yes key="i" />, <No key="t" />, <>From <a href="#models">GET /api/models</a></>],
                ["Gemini CLI", <Yes key="s" />, <No key="n" />, <No key="i" />, <No key="t" />, "Any model name"],
                ["Antigravity", <Yes key="s" />, <No key="n" />, <No key="i" />, <Yes key="t" />, <>From <a href="#models">GET /api/models</a></>],
              ]}
            />
            <ul>
              <li>
                Each CLI runs at most 2 requests at a time. Others wait up to 30 seconds, then get{" "}
                <code>429</code>.
              </li>
              <li>
                A request that takes longer than 5 minutes is stopped, with <code>504</code>.
              </li>
              <li>
                When a CLI reaches its plan’s usage limit (Claude Code’s 5-hour or weekly limit,
                Codex’s, Gemini’s or Antigravity’s quota), the answer is <code>429</code>, with{" "}
                <code>retry_after</code> when the CLI said when the limit resets.
              </li>
              <li>
                Antigravity stops if it needs a permission nobody can grant while it runs on its
                own, such as running a command. The answer is <code>502</code>, with the
                permissions in <code>denied</code> and the conversation in{" "}
                <code>session_id</code>: allow them in agy’s <code>settings.json</code>, then send
                that <code>session_id</code> to carry on.
              </li>
              <li>
                Token counts are for that request alone, even in a long session, and input
                includes cached tokens, which are most of a Claude Code request.
              </li>
              <li>Each CLI has to be signed in on the machine before it can answer.</li>
            </ul>
          </Section>

          <Section id="errors" title="Errors">
            <p>
              Errors come back with an HTTP error status and a JSON body. Read its{" "}
              <code>error</code> field; errors from a local CLI use <code>detail</code> instead,
              and a cloud provider’s own errors are passed on in the provider’s format.
            </p>
            <CodeBlock code={ERROR_BODY} label="Example: 503" />
            <Table
              head={["Status", "Meaning"]}
              rows={[
                [<code key="c">400</code>, <>Something’s wrong with the request: invalid JSON, an unknown provider, no <code>prompt</code> or <code>messages</code>, or a bad <code>workdir</code>, <code>session_id</code> or model for a CLI.</>],
                [<code key="c">401</code>, "The key is missing or wrong, or this key can’t call this endpoint."],
                [<code key="c">402</code>, "The cloud provider wants payment (passed on from the provider)."],
                [<code key="c">403</code>, <>The access token is turned off or expired, or can’t use that provider (or images); <code>workdir</code> is outside the folders the gateway allows; or a request reached the gateway’s public door without coming through its address.</>],
                [<code key="c">404</code>, "No access token with that id."],
                [<code key="c">429</code>, <>Too many requests: the access token has used its tokens or requests for the period, or its requests a minute (<a href="#me">/api/me</a> says which), 10 wrong keys from your address in 10 minutes (for 15 minutes), every key of a cloud provider is rate limited or at its daily limit, a CLI reached its plan’s usage limit, a CLI already has 2 running, or every Groq key is at its transcription limit. <code>Retry-After</code> says how many seconds to wait, when that’s known.</>],
                [<code key="c">502</code>, "The provider failed: it couldn’t be reached, or the CLI failed or isn’t signed in."],
                [<code key="c">503</code>, <>The provider is paused. See <a href="#providers">Pause &amp; resume</a>.</>],
                [<code key="c">504</code>, "A CLI took longer than 5 minutes."],
              ]}
            />
            <p>Some errors carry more fields, so a program can recover on its own:</p>
            <Fields
              rows={[
                ["retry_after", "number", <>With <code>429</code>: seconds until the limit resets, the same as the <code>Retry-After</code> header. Only there when the provider or CLI said.</>],
                ["denied", "array", <>Antigravity: the permissions it needed and couldn’t get, e.g. <code>{`["command"]`}</code>.</>],
                ["session_id", "string", <>Antigravity, with <code>denied</code>: the conversation to carry on once the permissions are allowed.</>],
                ["partial_response", "string", "A CLI’s text from before it stopped."],
                ["stderr", "string", "The end of a CLI’s error output, with secrets hidden."],
              ]}
            />
            <CodeBlock code={LIMIT_BODY} label="Example: a CLI at its usage limit" />
            <Note>
              During a stream, a failure arrives as an <code>error</code> event instead, with the
              same fields and the status in <code>status</code>; the HTTP status stays{" "}
              <code>200</code>.
            </Note>
          </Section>

          <Section id="vscode" title="VS Code & phone">
            <p>
              The <strong>Thun Murex</strong> extension for VS Code (
              <code>duchpanhathun.ai-thun</code>) is a chat panel for this gateway: every provider
              and model, CLI sessions that carry on, teams of models that split up a task, approval
              of the CLI’s actions, and scheduled tasks and workflows.
            </p>
            <ul>
              <li>
                Set the gateway’s address in the <code>aiThun.baseUrl</code> setting, and the key
                with the command <strong>Thun Murex: Set API Key</strong>. VS Code keeps the key
                in its secret storage.
              </li>
              <li>
                It uses the error fields above: a team stopped by a usage limit carries on by
                itself once <code>retry_after</code> has passed, and an Antigravity run stopped
                for a permission picks up the same <code>session_id</code>.
              </li>
              <li>
                <strong>Phone app</strong>: run <strong>Thun Murex: Connect a Phone</strong> and
                scan the code. From the phone you can chat, approve the agent’s actions from a
                notification, change models, and run schedules and workflows. The phone only talks
                to VS Code, over Tailscale; VS Code sends the requests here with its own key.
              </li>
            </ul>
          </Section>

          <footer className={styles.footer}>
            <span>Thun Murex · self-hosted on thun-latitude-7280</span>
            <Link href="/">Back to the console</Link>
          </footer>
        </main>
      </div>
    </div>
  );
}
