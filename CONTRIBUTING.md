# Contributing

Thanks for wanting to help. Ideas, bug reports and pull requests are all welcome here, from a typo to a new provider.

## Share an idea or ask a question

- **An idea to improve it:** start a [Discussion](https://github.com/DuchPanhathun/Local-AI-Gateway/discussions) in
  *Ideas*. Say what you were trying to do and what got in the way; the best ideas start from a real problem.
- **Something is broken:** open an [issue](https://github.com/DuchPanhathun/Local-AI-Gateway/issues/new/choose) with the
  steps to see it, what you expected, and your system. **Remove your API keys and tokens from anything you paste.**
- **A security problem:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).

For a change that is more than a small fix, talk first (a Discussion or an issue), so nobody builds something that
doesn't fit. A pull request that arrives with no earlier conversation is still read, but may be turned down.

## What is in this repository

| Folder | What it is |
|---|---|
| `src/app/` | The console (pages and components) and `src/app/api/`, the HTTP routes such as `/api/chat` |
| `src/lib/` | The server logic: `ai-providers.ts` (cloud providers, key rotation, streaming), `local-agent.ts` (the client for the local CLI and website gateways), `usage-ledger.ts`, `pricing.ts`, `api-tokens.ts`, `auth.ts` |
| `packaging/` | The `npx local-ai-gateway` package: the launcher, its tests, the patches applied to the gateways, third-party licenses |
| `scripts/` | The tests, and the package build |
| `deploy/` | The maintainer's own hosting (systemd, a public door, a Vercel front door). You don't need it to contribute |

The two gateways that run the CLIs and the websites (`local-agent` and `chatgpt-web`) are separate projects and aren't
in this repository; `packaging/patches/` only holds the changes the package makes to them. Ideas about them are welcome as
Discussions.

## Run it on your computer

You need Node.js 24 or newer.

```bash
npm install
cp .env.example .env     # then set APP_API_KEY to any long random string: it is the console's sign-in key
npm run dev              # http://localhost:3000
```

No provider key is needed to start; a provider without one shows "No API key" until you add one (put it in `.env`, or
paste it in the console on **Manage → Provider keys**). `.env` is ignored by git: never commit it.

Point the console's saved data (usage, keys you add, pauses) at a scratch folder while you work, so testing doesn't
mix with real use:

```bash
AI_THUN_STATE_DIR=/tmp/ai-thun-dev npm run dev
```

**This is not the Next.js you may know.** The version here has breaking changes. Read the relevant guide in
`node_modules/next/dist/docs/` before changing how a page, route or config works.

## Before you open a pull request

```bash
npm run typecheck  # types (it generates Next's route types first)
npm run lint        # eslint
npm test            # the pure tests in scripts/test-*.mts (Node's test runner)
```

If you changed the package (`packaging/`), also run `npm test` inside `packaging/local-ai-gateway`, and
`node packaging/tests/smoke.mjs` (needs Python 3.11+ and the internet). To try the whole package:
`npm run build:package`, then `node packaging/tests/real.mjs`. GitHub runs these checks on every pull request.

- **Tests:** add one for what you fix or add. A test of the pure logic goes in `scripts/test-<name>.mts` with
  `node:test`, and `npm test` picks it up. Check a change that talks to a provider against that provider's real
  answers, not only a guess of what it sends, and never put a real key in a test.
- **Style:** match the code around yours: its naming, its level of comments (they say *why*, not *what*), its idioms.
- **Dependencies:** please don't add one without a Discussion first. The package ships third-party code, and its build
  stops when a dependency hasn't been accounted for (`scripts/third-party-notices.mjs`).
- **UI changes:** include a screenshot, and check a phone-width screen (about 390 px) as well.
- **Docs:** if behaviour changes, update the README and the console's Documents page (`src/app/documents/page.tsx`).

### Adding a provider

The latest two are good examples to read: Coarena (`git show f96626b`) and Google AI Studio (`git show 38e005b`). A
provider touches `src/lib/ai-providers.ts` (its config, limits and model list), `src/app/providers.ts` (its name),
`src/lib/pricing.ts` and `src/lib/shop.ts` (prices), the Documents page and the README.

## How pull requests are handled

One person maintains this project, so reviews may take a few days. Small, focused pull requests are reviewed fastest.
Merging a pull request does **not** deploy anything: the hosted service is deployed by hand by the maintainer. Changes
to `deploy/`, `.github/`, `scripts/build-package.mjs` and `package.json` get a closer look, because they touch hosting
and the build.

## Licensing

By sending a contribution you agree that it is licensed under the [MIT License](LICENSE) of this repository, like the
rest of the project. Only send work you have the right to share this way.

## Be kind

Be patient with newcomers, disagree about the work and not the person, and assume good intent. Harassment or abuse gets
you blocked from the project.
