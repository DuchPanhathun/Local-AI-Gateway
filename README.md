# Thun Murex

<img src="public/thun-murex-logo.svg" alt="Thun Murex logo" width="72">

**Thun Murex** (this repository: `ai-thun`) is a Next.js API endpoint that proxies chat requests to cloud providers —
[SEA-LION](https://sea-lion.ai) (AI Singapore's free, OpenAI-compatible LLM API),
[Cerebras](https://cloud.cerebras.ai), or [Groq](https://console.groq.com), round-robining across
multiple API keys per provider so it doesn't hit any one key's rate limit — **and** to real AI
coding CLIs (Claude Code, Codex, Gemini, Antigravity) running on this machine via
[`local-agent-gateway`](../local-agent), a separate local-only service. Same `/api/chat` endpoint,
same response shape, regardless of which kind of provider answered.

Self-hosted on **thun-latitude-7280**, reachable only from your tailnet at
`https://thun-latitude-7280.tail26930f.ts.net:8443` (`tailscale serve`, not Funnel — nothing here
is on the public internet). Runs as the `ai-thun` systemd user service; see
[deploy/ai-thun.service](deploy/ai-thun.service). No longer deployed to Vercel.

## Setup

```bash
npm install
cp .env.example .env   # already done if you're reading this after initial setup
```

Fill in `.env`:

- `SEA_LION_API_KEY1`, `SEA_LION_API_KEY2`, ... — get keys from the
  [SEA-LION Playground](https://playground.sea-lion.ai) (one key per Google account; the docs cap it
  at 1 key per account). The route checks `SEA_LION_API_KEY1` through `SEA_LION_API_KEY21` and uses
  whichever are set.
- `CEREBRAS_API_KEY1`, `CEREBRAS_API_KEY2`, ... — get keys from
  [cloud.cerebras.ai](https://cloud.cerebras.ai). Same `1..21` convention as SEA-LION.
- `GROQ_API_KEY1`, `GROQ_API_KEY2`, ... — get keys from
  [console.groq.com/keys](https://console.groq.com/keys). Same `1..21` convention.
- `APP_API_KEY` — a secret you make up. This is your **owner** credential: it calls `/api/chat`
  directly, and it's the only thing that can log into the home page (`/`) to view quota usage or generate/
  revoke API tokens (see below). Leave it blank to disable auth entirely (not recommended once the
  URL is public).
- `ALLOWED_ORIGIN` (optional) — restrict CORS to one caller's origin instead of `*`.
- `EDGE_CONFIG`, `EDGE_CONFIG_ID`, `VERCEL_TEAM_ID`, `VERCEL_API_TOKEN` — back the dynamic API token
  store (see **Dashboard & API tokens** below). Not needed for `/api/chat` itself to work with
  `APP_API_KEY` alone; only needed if you want to generate separate, revocable tokens for other
  callers.

Run locally:

```bash
npm run dev
```

## Calling the endpoint

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello!"}'
```

Or with a full OpenAI-style message array:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}'
```

The response is the provider's raw chat-completion JSON (OpenAI-compatible), so
`response.choices[0].message.content` is the model's reply.

From a browser or another app, `fetch` it the same way — CORS is open by default (or restricted to
`ALLOWED_ORIGIN` if you set it).

### Choosing a provider and model

Default is SEA-LION with its default model. Pass `provider` and/or `model` to override either:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider": "cerebras", "model": "gpt-oss-120b", "prompt": "Hello!"}'
```

- `provider`: `"sea-lion"` (default), `"cerebras"`, `"groq"`, a local CLI, or `"chatgpt"` /
  `"grok"` / `"mimo"` (both below).
- `model`: any model id the chosen provider supports. If omitted, falls back to
  `SEA_LION_MODEL`/`CEREBRAS_MODEL`/`GROQ_MODEL` from `.env`, or each provider's built-in default.

### Listing models

`GET /api/models` returns every provider's selectable models in one response (APP_API_KEY or any
access token):

```json
{"providers": {
  "groq":   {"kind": "cloud", "default": "openai/gpt-oss-120b", "models": [{"id": "openai/gpt-oss-20b", "name": "GPT OSS 20B"}, …], "note": null, "error": null, "paused": false},
  "claude": {"kind": "local", "default": null, "models": [{"id": "sonnet", "name": "Claude Sonnet (latest)"}, …], "note": "aliases for the latest model of each family …", "error": null, "paused": false},
  …}}
```

Cloud lists come live from each provider's own `/models`, filtered to chat models (embeddings,
rerankers, Whisper, text-to-speech and guard classifiers are dropped — Groq reports modalities,
SEA-LION and Cerebras are filtered by name) and cached for 10 minutes. Local lists come from
local-agent-gateway's `/models`. Gemini CLI can't list its models, so its list is empty and any
model name is passed through. A paused cloud provider (see [Pausing a provider](#pausing-a-provider))
isn't asked for its list; it shows only its default model.

### Streaming

`POST /api/chat/stream` takes the same body as `/api/chat` and answers with Server-Sent Events, for
every provider:

| event | data | |
|---|---|---|
| `start` | `{"provider"}` | |
| `thinking` | `{"text"}` | cloud reasoning models only (SEA-LION, Groq/Cerebras gpt-oss): the reasoning, as it's generated |
| `delta` | `{"text"}` | the answer, as it's generated |
| `done` | `{"provider", "model", "result", "finish_reason", "usage", "duration_ms"}` | `result` is the full answer; `usage` is `{"prompt_tokens", "completion_tokens", "total_tokens"}`. Local CLIs add `session_id` and have no `finish_reason`; their `usage` is `null` for Codex and Gemini, which don't report tokens |
| `error` | `{"status", "detail"}` | ends the stream |

Errors before the stream opens (bad model, 401, 402 billing) are ordinary JSON responses with a
`{"error": "..."}` body. Disconnecting mid-stream cancels the upstream work: a cloud provider's
request is aborted, and a local CLI's process is killed by local-agent-gateway.

`finish_reason: "length"` means `max_tokens` ran out. With reasoning models that can happen before
any answer is written (an empty `result`) — raise `max_tokens`, or for SEA-LION send
`"chat_template_kwargs": {"enable_thinking": false}`.

## Speech-to-text

`POST /api/transcribe` turns audio into text with Groq's Whisper, using the same `GROQ_API_KEY*` keys and
rotation as chat. It takes the same multipart form as OpenAI's and Groq's `/audio/transcriptions`, so
OpenAI-compatible clients only need its address and your key:

```bash
curl -X POST http://localhost:3000/api/transcribe \
  -H "Authorization: Bearer $APP_API_KEY" \
  -F file=@line.wav \
  -F response_format=json
```

```json
{"text": " I waited for you until midnight.", "x_groq": {"id": "req_…"}}
```

- `file` (required): the audio, as a file upload. Vercel caps a request at 4.5 MB.
- `model`: defaults to `GROQ_TRANSCRIBE_MODEL` from `.env`, else `whisper-large-v3-turbo` (Groq's fastest).
- `prompt`, `language`, `response_format` (`json`, `verbose_json` or `text`) and `temperature` are passed on
  to Groq; other fields are dropped.

The answer is Groq's, as Groq sent it. Groq limits each key to 20 Whisper requests a minute and 2,000 a day
(its published figures for the Developer plan; your Groq console shows your own) and bills each request as at
least 10 seconds of audio. A key that answers 429 is skipped for the next one; when every key is limited, the
caller gets the 429 with a `Retry-After` header, the shortest wait any key asked for. The dashboard counts
Whisper requests per key, next to chat.

## Local agent CLIs (Claude Code, Codex, Gemini, Antigravity)

`provider: "claude" | "codex" | "gemini" | "antigravity"` routes through the same `/api/chat` —
these aren't cloud APIs, they're real CLI subprocesses on this machine, proxied via
[`local-agent-gateway`](../local-agent) (`LOCAL_AGENT_URL`/`LOCAL_AGENT_TOKEN` in `.env`, default
`http://127.0.0.1:8787`). Its own `WORKDIR_ALLOWLIST`/security model is the real trust boundary —
this app just forwards and normalizes.

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $APP_API_KEY" -H "Content-Type: application/json" \
  -d '{"provider": "claude", "prompt": "What does this project do?", "workdir": "/home/me/projects/app"}'
```

Extra fields these providers understand: `session_id` (resume an earlier run — reuse the same
`workdir`), `workdir` (absolute path inside local-agent-gateway's allowlist), `no_tools` (`true`
runs the CLI as a plain model with no file/shell access — claude and codex only). The response is
normalized into the same `choices[0].message.content` shape every other provider returns, plus
`session_id`/`duration_ms` at the top level and `usage` (`prompt_tokens`, `completion_tokens`,
`total_tokens`) for the CLIs that report it.

**Tokens**: Claude Code and Antigravity report what each run used; `prompt_tokens` counts every
input token the model read, cached or not (most of a Claude Code run is its cached system
prompt), and `completion_tokens` includes thinking. It is that run alone, even on a resumed session
— the CLIs' own session totals are not used, so a conversation isn't counted twice. Codex and
Gemini don't report tokens (`usage: null`).

**Streaming**: `POST /api/chat/stream`, same body — local-agent-gateway's own `/ask/stream`
events are relayed as they arrive (same event format as above; only `done.usage` is renamed to
the cloud providers' field names).

**Image generation** (Codex only, via its built-in `image_gen` tool): `POST /api/image` with
`{"prompt": "...", "images": [{"data_base64": "...", "label": "..."}]}` (up to 5, for edits/refs).
Returns `{"image_base64": "...", "mime_type": "image/png", ...}`.

CLI install/login status (not usage): `GET /api/local-agent/health` (owner-only), also shown on
the dashboard. A CLI showing `installed: true` still needs its own interactive login — SSH into
the host and run `claude` / `codex login` / `gemini` / `agy` once each.

Plan limits: `GET /api/local-agent/limits` (owner-only) relays the gateway's `GET /limits`: per
CLI, how much of each subscription limit is left (`remaining_fraction`) and when it resets
(`resets_at`), from the CLIs that can say: Claude Code (`claude -p /usage`: the 5-hour session
and the weekly limits) and Antigravity (`agy -p /quota`), neither of which uses any of it. Shown
under Analytics → Plan limits and on the dashboard's CLI cards. Cached 2–5 minutes.

## ChatGPT, Grok and MiMo on the web (`chatgpt`, `grok`, `mimo`)

`provider: "chatgpt"`, `"grok"` and `"mimo"` answer through chatgpt.com, grok.com and Xiaomi MiMo
Studio (aistudio.xiaomimimo.com) themselves:
[`chatgpt-web-gateway`](../chatgpt-web) types the prompt into the site in its own Chrome window,
signed in to your accounts, and reads the reply back as Markdown. It speaks local-agent-gateway's
API, so they work like the CLIs above — same `/api/chat` and `/api/chat/stream`, same response
shape, same usage ledger and dashboard cards — at its own address
(`CHATGPT_WEB_URL`/`CHATGPT_WEB_TOKEN` in `.env`, default `http://127.0.0.1:8789`). Setup (sign-in,
starting it) is in its README.

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $APP_API_KEY" -H "Content-Type: application/json" \
  -d '{"provider": "chatgpt", "prompt": "Explain CORS in two sentences."}'
```

- `model`: chatgpt: `auto` (default: whatever the account's plan gives) or `think` (ChatGPT's Think
  on). grok: `fast` (default, the free plan's; it reasons 10–35 s before answering), or `auto`,
  `expert`, `heavy` with SuperGrok. mimo: `mimo-v2.6-pro` (default) or `mimo-v2.6-flash`; MiMo's
  reasoning streams as `thinking` events. (MiMo Studio's TTS and ASR models take or give audio, which
  this endpoint doesn't carry.)
- `temporary`: default `true`, ChatGPT's temporary chat or Grok's private chat, kept out of the
  account's history. It can't be continued, so `session_id` comes back `null`. Send `false` to save
  the chat and get a `session_id`; send that back to continue it. The Playground does this. MiMo
  has no such chats: every `mimo` chat is saved and returns a `session_id`.
- No `workdir`/`no_tools`, no images, and no token counts (`usage: null`).
- One prompt at a time per site (the three can answer at once); others wait up to the gateway's
  `QUEUE_TIMEOUT_S`, then get 429.
- MiMo shows links in its answers without their addresses, so they come back as plain text.
- These are websites, not APIs: their makers' terms don't allow automated use, so the accounts
  can be limited or banned, and replies count against the plans' limits. They break when a page
  changes. When a site shows a check, an age question or signs out, requests fail with 503 until
  someone deals with it in that Chrome window; the gateway doesn't get around checks.

## How key rotation works

`src/lib/ai-providers.ts` round-robins every request across whichever `<PROVIDER>_API_KEY*` vars
are set for the chosen provider, and if a key comes back rate-limited (HTTP 429) it retries with
the next one before giving up. This is a best-effort spread (the rotation cursor lives in memory
per serverless instance, not a shared counter), not an exact quota tracker — but with N keys spread
evenly you can sustain roughly `<per-key limit> * N` requests/min before any single key gets hit.

**Groq only** also tracks each key's token usage for the current UTC day, and once a key crosses
`GROQ_DAILY_TOKEN_LIMIT` (default `500000`) it's skipped in favor of the next key until the day
rolls over. That count comes from the usage ledger (below), so it survives restarts and deploys.

## Usage history

Every request through the gateway — every provider, cloud or local — is counted in a ledger:
requests, failures, and input/output/total tokens per UTC day, provider and model (and, for cloud
APIs, per key). It's saved to `~/.local/state/ai-thun/usage.json` (`AI_THUN_STATE_DIR` to move it)
a second after each change and again on shutdown, so restarts and deploys keep it; days older than
about 13 months are dropped. The Dashboard's daily and monthly numbers and Analytics' daily totals
come from it; only the per-minute columns in Analytics are kept in memory.

`GET /api/usage?month=2026-10` (owner-only; default: the current UTC month) returns one month:

```json
{"month": "2026-10", "months": ["2026-10", "2026-09"],
 "totals": {"requests": 31, "errors": 0, "promptTokens": 122819, "completionTokens": 12995, "totalTokens": 135814},
 "models": [{"provider": "claude", "model": "claude-haiku-5-5", "requests": 9, "totalTokens": 55157, "tokensReported": true, …}, …],
 "days": [{"day": "2026-10-01", "requests": 0, "totalTokens": 0}, …]}
```

`models` is sorted by tokens, most first. `tokensReported: false` means none of that model's
requests said how many tokens they used (Codex, Gemini CLI, Whisper), so its zeros mean unknown.

## Dashboard & API tokens

Visit the home page (`/`) and sign in with `APP_API_KEY`. The console has five sections (light and
dark themes, following the OS unless you pick one in the sidebar):

- **Dashboard** — today's totals; monthly usage (total, input and output tokens, requests, a bar
  per day, and every model used with its tokens and share, for any month on record); and a card
  per provider: keys, models, requests, tokens, CLI install state, paused or not.
- **Playground** — chat with any provider and model, streamed, with reasoning shown live for
  thinking models, a Stop button, and Workbench-style settings (max tokens, temperature, SEA-LION's
  thinking switch for cloud; working directory and session for local CLIs).
- **API keys** — access tokens (below).
- **Analytics** — today's usage. Cloud APIs: per key and model, against each provider's published
  limits (requests/min, tokens/min, requests/day, tokens/day), idle keys hidden unless you ask.
  Local CLIs: runs per CLI and model, with failures, input/output tokens (where the CLI reports
  them) and average latency; a run you stop counts as a request, not a failure. Daily totals
  come from the usage ledger; the per-minute columns start over when the server restarts.
- **Manage** — pause or resume providers, API reference with copyable requests, and local CLI
  status.

The full API documentation is at **`/documents`**: every endpoint, field, response and error, with
curl, JavaScript and Python examples. It needs no sign-in, since it holds no keys (examples read
them from `$AI_THUN_URL` and `$AI_THUN_KEY`).

`GET /api/quotas` (owner-only) returns the same numbers: `keys` (every cloud key), `local` (each
CLI and model used today) and `paused`.

### Pausing a provider

A paused provider turns every request away with HTTP 503 — from the Playground and from apps using
access tokens alike — until you resume it; its keys and CLI login are left alone. Pausing Groq also
pauses `/api/transcribe`, and pausing Codex pauses `/api/image`. Pause and resume from **Manage**,
or with the owner key:

```bash
curl -X PATCH http://localhost:3000/api/providers \
  -H "Authorization: Bearer $APP_API_KEY" -H "Content-Type: application/json" \
  -d '{"provider": "cerebras", "paused": true}'
# → {"paused": ["cerebras"]}
```

`GET /api/providers` returns the list. It's saved in `~/.local/state/ai-thun/providers.json`
(`AI_THUN_STATE_DIR` to move it), outside the project folder, so restarts and deploys keep it.

**Access tokens** are separate, revocable credentials you can hand out to other apps/people
  instead of your `APP_API_KEY`. A generated token can call `/api/chat`, `/api/chat/stream`,
  `/api/image`, `/api/transcribe` and `/api/models`, and *nothing else* — it cannot log into the home page (`/`),
  view quotas or CLI health, list other tokens, or generate more tokens. Only `APP_API_KEY`
  (i.e. only you) can do that. The full token value is shown once, at creation time, then only a
  masked version (`sk-ai-thun-ab12…cd34`) is shown afterward. Revoke any token instantly from the
  same page.

Unlike the quota numbers, the token list is **not** best-effort — it's stored in
[Vercel Edge Config](https://vercel.com/docs/edge-config), a real external store, so every
serverless instance and every deployment sees the same list and a revoke takes effect immediately.

Setting this up requires four env vars (`EDGE_CONFIG`, `EDGE_CONFIG_ID`, `VERCEL_TEAM_ID`,
`VERCEL_API_TOKEN`) pointing at an Edge Config store and a Vercel API token with write access to it.
**Security note:** Vercel doesn't support minting a narrowly-scoped token for just one Edge Config
via API, so `VERCEL_API_TOKEN` here has full account access — treat it exactly like your Vercel
login (stored server-side only, never sent to the browser, but rotate it via
`vercel logout && vercel login` plus updating the env var if you ever suspect it leaked).

## Deploying (self-hosted on thun-latitude-7280, via Tailscale)

Local-agent providers only work where their CLIs are installed and logged in, so this runs on the
same machine as `local-agent-gateway` rather than on Vercel. Redeploy after a code change:

```bash
# from this repo, on the machine you're developing on
rsync -az --delete --exclude .git/ --exclude node_modules/ --exclude .next/ --exclude .env \
  --exclude deploy/vercel/.vercel/ --exclude deploy/vercel/.env.local \
  ./ thun@100.81.199.119:~/Desktop/documents/Project/ai-thun/
ssh thun@100.81.199.119 '
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
  cd ~/Desktop/documents/Project/ai-thun && npm install && npm run build
  systemctl --user restart ai-thun
'
```

`.env` on the host isn't touched by rsync (excluded), nor is the Vercel link `deploy/vercel/deploy.sh` makes there — edit it there directly if it needs to change,
then `systemctl --user restart ai-thun`.

First-time setup: [deploy/ai-thun.service](deploy/ai-thun.service) installed to
`~/.config/systemd/user/ai-thun.service` (`systemctl --user enable --now ai-thun`), bound to
`127.0.0.1:3000`, exposed to the tailnet with `tailscale serve --bg --https=8443 http://127.0.0.1:3000`.
**Port 8443, not 443** — 443 is already Funneled (public internet) for a different project
(`marketing-agent`, which needs it for a Telegram webhook); `tailscale serve`/`funnel` share one slot
per port, so don't run anything on 443 here without checking `tailscale serve status` first.

### The public address: https://thun-murex.duchpanhathun.com

The tailnet address above stays as it is. For the internet, there's one more way in, and only
one, with four parts:

1. **Vercel** serves `thun-murex.duchpanhathun.com` (free, with its certificate) and forwards every
   request to the Latitude, adding a secret header, `x-origin-secret`
   ([deploy/vercel/vercel.json](deploy/vercel/vercel.json)).
2. **Tailscale Funnel** carries it to the Latitude, on Funnel's port 10000:
   `tailscale funnel --bg --https=10000 http://127.0.0.1:3001`.
3. **The public door** ([deploy/public-door.mjs](deploy/public-door.mjs), user service
   `thun-murex-door` on `127.0.0.1:3001`) refuses whatever lacks the secret. What it lets through
   goes to the gateway marked `x-thun-public: 1`, with the visitor's address in `x-real-ip`, and
   comes back with `Cache-Control: no-store` so Vercel keeps none of it (the build's own files
   aside). Funnel never points at the gateway's own port.
4. **The gateway** applies its internet rules to what's marked public
   ([src/lib/auth.ts](src/lib/auth.ts)): keys compared in constant time, 10 wrong keys in 10 minutes
   lock an address out for 15 minutes, and no requests at all without `APP_API_KEY`. The console signs
   in with a cookie its scripts can't read (`/api/session`). Streams send a `: keep-alive` comment
   every 20 s while quiet: Vercel waits at most 2 minutes for data, so an answer that doesn't stream
   has to start within 2 minutes when it comes through this address.

Setting it up, on the Latitude:

```bash
deploy/setup-door.sh                                   # ORIGIN_SECRET in .env, and the door's service
tailscale funnel --bg --https=10000 http://127.0.0.1:3001
deploy/vercel/deploy.sh                                # after `vercel login`
deploy/vercel/dns.sh                                   # after `aws login --profile personal --region us-east-1`
```

To close it again: `tailscale funnel --https=10000 off`. To change the secret: a new `ORIGIN_SECRET`
in `.env`, then `systemctl --user restart thun-murex-door` and `deploy/vercel/deploy.sh`.

The route sets `maxDuration = 300`; that's a Vercel/serverless concept and has no effect self-hosted
(`next start` has no per-request timeout), left as-is in case this ever moves back to Vercel.
