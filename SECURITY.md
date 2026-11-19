# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately on GitHub:

**Security tab → Report a vulnerability** (or <https://github.com/DuchPanhathun/Local-AI-Gateway/security/advisories/new>).

Include what you found, the steps to reproduce it, and which version or commit. Don't include real API keys or tokens in
a report. You will get an answer as soon as the maintainer can; this is a one-person project, so please allow a few days.

## What is covered

- The latest version of the npm package [`local-ai-gateway`](https://www.npmjs.com/package/local-ai-gateway), and the
  `main` branch of this repository.
- The console and its API (`src/`), the launcher (`packaging/`), and the way keys, tokens and sign-in are handled.

## Good to know

- `local-ai-gateway` runs on your own computer and listens on `127.0.0.1` only. It drives your own accounts with other
  companies' tools; their terms are theirs, and they are not covered here.
- API keys added in the console are stored on the machine it runs on, readable only by its user, and the console only
  ever shows a masked form.
