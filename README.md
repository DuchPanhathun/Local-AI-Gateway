# ai-thun

A Next.js API endpoint that proxies chat requests to [SEA-LION](https://sea-lion.ai) (AI Singapore's
free, OpenAI-compatible LLM API) or [Cerebras](https://cloud.cerebras.ai), round-robining across
multiple API keys per provider so it doesn't hit either one's per-key rate limit.

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
- `APP_API_KEY` — a secret you make up. Callers must send it back as
  `Authorization: Bearer <APP_API_KEY>`. This is what stops random people from burning through your
  free quota once the URL is public. Leave it blank to disable auth entirely.
- `ALLOWED_ORIGIN` (optional) — restrict CORS to one caller's origin instead of `*`.

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

- `provider`: `"sea-lion"` (default) or `"cerebras"`.
- `model`: any model id the chosen provider supports. If omitted, falls back to
  `SEA_LION_MODEL`/`CEREBRAS_MODEL` from `.env`, or each provider's built-in default.

Known Cerebras models as of writing: `qwen-3.8-27b` (default, most generous quota),
`gemma-4-31b` (preview, 5 req/min), `gpt-oss-120b` (production, 5 req/min) — check
[cloud.cerebras.ai](https://cloud.cerebras.ai) for the current list and quotas.

## How key rotation works

`src/lib/ai-providers.ts` round-robins every request across whichever `<PROVIDER>_API_KEY*` vars
are set for the chosen provider, and if a key comes back rate-limited (HTTP 429) it retries with
the next one before giving up. This is a best-effort spread (the rotation cursor lives in memory
per serverless instance, not a shared counter), not an exact quota tracker — but with N keys spread
evenly you can sustain roughly `<per-key limit> * N` requests/min before any single key gets hit.

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
