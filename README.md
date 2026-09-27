# ai-thun

A Next.js API endpoint that proxies chat requests to [SEA-LION](https://sea-lion.ai) (AI Singapore's
free, OpenAI-compatible LLM API), [Cerebras](https://cloud.cerebras.ai), or [Groq](https://console.groq.com),
round-robining across multiple API keys per provider so it doesn't hit any one key's rate limit.

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
  directly, and it's the only thing that can log into `/dashboard` to view quota usage or generate/
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

- `provider`: `"sea-lion"` (default), `"cerebras"`, or `"groq"`.
- `model`: any model id the chosen provider supports. If omitted, falls back to
  `SEA_LION_MODEL`/`CEREBRAS_MODEL`/`GROQ_MODEL` from `.env`, or each provider's built-in default.

Known Cerebras models as of writing: `qwen-3.8-27b` (default, most generous quota),
`gemma-4-31b` (preview, 5 req/min), `gpt-oss-120b` (production, 5 req/min) — check
[cloud.cerebras.ai](https://cloud.cerebras.ai) for the current list and quotas.

## How key rotation works

`src/lib/ai-providers.ts` round-robins every request across whichever `<PROVIDER>_API_KEY*` vars
are set for the chosen provider, and if a key comes back rate-limited (HTTP 429) it retries with
the next one before giving up. This is a best-effort spread (the rotation cursor lives in memory
per serverless instance, not a shared counter), not an exact quota tracker — but with N keys spread
evenly you can sustain roughly `<per-key limit> * N` requests/min before any single key gets hit.

**Groq only** also tracks each key's token usage for the current UTC day, and once a key crosses
`GROQ_DAILY_TOKEN_LIMIT` (default `500000`) it's skipped in favor of the next key until the day
rolls over. Same best-effort caveat as the rotation cursor — it's an in-memory counter per warm
serverless instance, not an exact ledger synced across concurrent instances.

## Dashboard & API tokens

Visit `/dashboard` and sign in with `APP_API_KEY` to:

- See per-key, per-model quota usage (requests/min, tokens/min, requests/day, tokens/day against
  each provider's published limits) — this part is best-effort and in-memory (see caveat above).
- **Generate API tokens** — separate, revocable credentials you can hand out to other apps/people
  instead of your `APP_API_KEY`. A generated token can call `/api/chat` and *nothing else* — it
  cannot log into `/dashboard`, list other tokens, or generate more tokens. Only `APP_API_KEY`
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

## Deploying to Vercel (free Hobby plan)

```bash
npx vercel        # first deploy, links the project
npx vercel env add APP_API_KEY production
npx vercel env add SEA_LION_API_KEY1 production
# ...repeat env add for each SEA_LION_API_KEY you have
npx vercel --prod
```

Or push to GitHub and import the repo at [vercel.com/new](https://vercel.com/new), then add the same
env vars under Project Settings → Environment Variables before deploying.

The route sets `maxDuration = 60`, the max Vercel allows on the Hobby plan.
