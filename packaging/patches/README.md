# Gateway patches

`local-agent` and `chatgpt-web` are separate projects, not in this repo. The package runs on Linux,
macOS and Windows, and what that took inside them is kept here, so `npm run build:package` ships it
whatever the gateway checkouts look like:

| patch | what it changes |
|---|---|
| `local-agent.patch` | `runner.py`: ending a CLI and everything it started on Windows (no `killpg`, no `SIGKILL`), a new process group instead of a session, and a guard so a `.cmd` file (how npm installs Codex and Gemini CLI there) never gets an argument `cmd.exe` would run |
| `chatgpt-web.patch` | `chrome.py`: starting Chrome detached on Windows, and finding the Chrome that has the profile open without `/proc` (macOS, Windows). `config.py`: each system's own default Chrome profile, which can't be used. `pyproject.toml`: `psutil` |

The build applies each patch to its gateway's copy with `git apply`. A gateway that already has the
changes is left alone, and one the patch no longer fits stops the build, with git's reason.

They are made against each gateway's repo root, so to move one into the gateway itself:

```bash
cd path/to/local-agent && git apply path/to/this/repo/packaging/patches/local-agent.patch
```

After that the build says "already has the changes", and the patch file can be deleted.

To make one again after a gateway changed: copy the gateway to `a/` and `b/`, change `b/`, and
`git diff --no-index a b` (with the `a/a/` and `b/b/` prefixes taken out of the paths).

## Checking them

`packaging/tests` holds two checks that need no gateway source beyond the built copy:

```bash
node packaging/tests/smoke.mjs                      # the launcher, start to stop, with stand-in programs
python -m unittest discover packaging/tests         # the patched code against real processes
```

The second needs the built gateways (`npm run build:package` leaves them in
`packaging/local-ai-gateway/gateways`, or set `LOCAL_AI_GATEWAY_GATEWAYS`) and `psutil` installed, and
`playwright` for the web gateway's tests, which are skipped without it. Run both on each system the
package should run on: `.github/workflows/package.yml` does that on GitHub.
