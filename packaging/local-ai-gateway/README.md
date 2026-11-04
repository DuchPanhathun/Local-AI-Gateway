# Local AI Gateway

One console and one API, on your own computer, in front of **your own** AI tools:
Claude Code, Codex, Gemini CLI, Antigravity, and (optionally) your ChatGPT, Grok and MiMo
accounts in the browser. Nothing to clone, nothing to configure:

```bash
npx local-ai-gateway
```

The first run sets itself up (about a minute, needs the internet), then opens the console in
your browser, already signed in. Press Ctrl+C in the terminal to stop everything.

## What you need

- **Node 20+** and **Python 3.11+** (the gateways are Python), on **Linux or macOS**.
- The tools you want to use, installed and **signed in the way their makers describe**. This
  doesn't install them or log you in; it finds them on your `PATH`. The ones it doesn't find show
  as "Not installed" in the console.
- For the websites only: Google Chrome (or Chromium).

## What it does

It starts three things, all listening on `127.0.0.1` only (no other computer can reach them):

| | |
|---|---|
| the console and API | `http://127.0.0.1:3000`: a Playground to chat with any of your tools, Manage (pause, resume, test), usage, and an API your own programs can call |
| a gateway for CLIs | runs Claude Code, Codex, Gemini CLI and Antigravity headless, as you |
| a gateway for websites | (only with `--web`) types into ChatGPT, Grok and MiMo in its own Chrome window |

The console's key is made on your computer on the first run and kept in `~/.local-ai-gateway`
(readable only by you). `npx local-ai-gateway key` shows the link and the key again.

## Commands

```bash
npx local-ai-gateway                 # start (sets up on the first run)
npx local-ai-gateway --allow ~/code  # let the CLIs work in ~/code too (remembered)
npx local-ai-gateway --web           # also run the ChatGPT / Grok / MiMo gateway
npx local-ai-gateway web-signin      # then sign in to those sites in its Chrome window, once
npx local-ai-gateway key             # show the console link and API key
npx local-ai-gateway --help
```

## Things to know

- **The CLIs can read and work in the folders you allow.** By default that is an empty folder,
  `~/.local-ai-gateway/workspace`. Allowing a project folder lets a model read (and, depending on the
  CLI's own settings, change) files there, so allow only what you mean to.
- **Their usage is yours.** Chats count against your own Claude, ChatGPT, Google and other plans.
  Nothing is tested by itself: the Manage page's Test button sends one tiny chat when you press it.
- **The websites are not APIs.** Their terms don't allow automated use, so your accounts could be
  limited or banned. The gateway asks you to accept this before it turns on, and it can't get past
  a Cloudflare check or a sign-in page: you do that in its Chrome window.
- **Cloud providers are optional.** Put API keys for Groq, Cerebras or SEA-LION in
  `~/.local-ai-gateway/env` (one `NAME=value` per line, then restart) if you have them.

## Where things are

Everything is in `~/.local-ai-gateway` (or `$LOCAL_AI_GATEWAY_HOME`): `config.json` (keys), `venv/`
(the Python packages), `app/` (the console), `state/` (usage and pauses), `logs/`, `workspace/`.
To remove it all: delete that folder.

## If something doesn't work

- **"Python 3.11 or newer is needed"**: install Python, then run the command again.
- **"Couldn't create a Python environment"** on Debian or Ubuntu: `sudo apt install python3-venv`.
- **A tool shows "Not installed"**: it isn't on your `PATH` in this terminal.
- **A tool shows "Not responding"** after you press Test: the message is the tool's own, usually
  that it needs signing in. Sign in to it in your terminal, then press Test again.
- The logs are in `~/.local-ai-gateway/logs`.
