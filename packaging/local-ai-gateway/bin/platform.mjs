// What differs between Linux, macOS and Windows for the launcher (cli.mjs): where programs
// are, how they're started, how a tree of them is stopped. Every function takes the platform
// (and the environment) as an argument, so the Windows and macOS answers can be checked from
// any computer: see test/platform.test.mjs.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

// Windows paths are built with path.win32 even when this runs elsewhere (in the tests).
export const flavour = (platform) => (platform === "win32" ? path.win32 : path.posix);

// An environment variable by name. Windows doesn't care about case ("Path" is "PATH").
export function envVar(env, name, platform = process.platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

// ---------------------------------------------------------------------------
// Finding programs
// ---------------------------------------------------------------------------

// What Windows starts by name without a shell, best first. A name with none of these
// ("claude") is tried with each ("claude.exe", then npm's "claude.cmd"). Not .ps1 or .js.
export const WINDOWS_EXECUTABLES = [".exe", ".cmd", ".bat", ".com"];

export function withExtensions(file, platform = process.platform) {
  if (platform !== "win32") return [file];
  return WINDOWS_EXECUTABLES.includes(path.win32.extname(file).toLowerCase()) ? [file] : WINDOWS_EXECUTABLES.map((ext) => file + ext);
}

function isExecutableFile(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// Windows has no execute bit: a file with the right extension is a program.
export const canRun = (platform = process.platform) => (platform === "win32" ? isFile : isExecutableFile);

// The first of `files` that is a program (on Windows, with or without its extension).
export function firstProgram(files, { platform = process.platform, check = canRun(platform) } = {}) {
  for (const file of files) for (const name of withExtensions(file, platform)) if (check(name)) return name;
  return null;
}

export function which(cmd, { platform = process.platform, env = process.env, check = canRun(platform) } = {}) {
  const p = flavour(platform);
  const dirs = (envVar(env, "PATH", platform) ?? "")
    .split(p.delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1")) // Windows lets a PATH entry be quoted
    .filter(Boolean);
  return firstProgram(dirs.map((dir) => p.join(dir, cmd)), { platform, check });
}

// Where a CLI is besides PATH. `cli.also` are paths under the home folder, written with "/".
export function cliFiles(cli, { platform = process.platform, env = process.env, home }) {
  const p = flavour(platform);
  const files = (cli.also ?? []).map((rel) => p.join(home, ...rel.split("/")));
  if (platform === "win32") {
    // npm's global folder (codex.cmd, gemini.cmd...), and where Claude Code's own installer puts claude.exe
    const roaming = envVar(env, "APPDATA", platform) ?? p.join(home, "AppData", "Roaming");
    files.push(p.join(roaming, "npm", cli.cmd), p.join(home, ".local", "bin", cli.cmd));
  }
  return files;
}

export function findCli(cli, options) {
  return which(cli.cmd, options) ?? firstProgram(cliFiles(cli, options), options);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

// Newest tested versions first, then whatever the bare names give.
export function pythonCandidates(platform = process.platform) {
  const tested = ["3.13", "3.12", "3.11"];
  if (platform === "win32") {
    // `py` comes with python.org's installer. A bare `python` may be the Microsoft Store's stub, which
    // fails when asked to run something, so it's tried last.
    return [
      ...tested.map((version) => ({ cmd: "py", args: [`-${version}`] })),
      { cmd: "py", args: ["-3"] },
      { cmd: "python", args: [] },
      { cmd: "python3", args: [] },
    ];
  }
  return [...tested.map((version) => ({ cmd: `python${version}`, args: [] })), { cmd: "python3", args: [] }, { cmd: "python", args: [] }];
}

export function findPython({ platform = process.platform, run = spawnSync } = {}) {
  for (const candidate of pythonCandidates(platform)) {
    const r = run(candidate.cmd, [...candidate.args, "-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status === 0 && Number(String(r.stdout).trim()) >= 311) return candidate;
  }
  return null;
}

export const venvPython = (venv, platform = process.platform) =>
  platform === "win32" ? path.win32.join(venv, "Scripts", "python.exe") : path.posix.join(venv, "bin", "python");

export function pythonHint(platform = process.platform) {
  if (platform === "win32") return 'Install it from python.org (tick "Add python.exe to PATH") or run: winget install Python.Python.3.13';
  if (platform === "darwin") return "Install it with Homebrew (brew install python) or from python.org";
  return "Install it with your package manager, or from python.org";
}

export function venvHint(platform = process.platform) {
  if (platform === "linux") return "On Debian or Ubuntu: sudo apt install python3-venv";
  return "Reinstall Python with its standard library and pip (python.org's installer has both).";
}

// ---------------------------------------------------------------------------
// Chrome (the websites' gateway drives it)
// ---------------------------------------------------------------------------

export function chromeFiles({ platform = process.platform, env = process.env, home }) {
  const p = flavour(platform);
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      p.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      p.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
  }
  if (platform === "win32") {
    const roots = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"].map((name) => envVar(env, name, platform)).filter(Boolean);
    return [...new Set(roots)].flatMap((root) => [
      p.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      p.join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return [];
}

export function findChrome(options) {
  const platform = options.platform ?? process.platform;
  const file = firstProgram(chromeFiles(options), options);
  if (file) return file;
  const names = platform === "win32" ? ["chrome"] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const name of names) {
    const found = which(name, options);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Starting and stopping things
// ---------------------------------------------------------------------------

export function browserCommand(url, platform = process.platform) {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  // Not `cmd /c start`: cmd would read the = and & in a link as its own syntax.
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

// Asks a child to stop. Windows has no SIGTERM: there, Ctrl+C in the terminal has reached
// every program sharing its console already, and killTree is what's left.
export function terminate(child, platform = process.platform) {
  if (platform !== "win32") child.kill("SIGTERM");
}

// Ends a child and everything it started. Windows doesn't signal process groups; taskkill walks the tree.
export function killTree(child, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  if (child.pid === undefined) return;
  if (platform === "win32") {
    const taskkill = path.win32.join(envVar(env, "SystemRoot", platform) ?? "C:\\Windows", "System32", "taskkill.exe");
    run(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

// Windows 10 and later have a tar of their own. Git for Windows puts GNU tar first on PATH, and
// that one reads "C:\app.tgz" as a file on a computer called "C".
export function tarCommand({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform === "win32") {
    const system = path.win32.join(envVar(env, "SystemRoot", platform) ?? "C:\\Windows", "System32", "tar.exe");
    if (exists(system)) return system;
  }
  return "tar";
}

// "~" and "~/code" (on Windows also "~\code") for the user's home.
export function expandHome(dir, home, platform = process.platform) {
  return dir.replace(platform === "win32" ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, home);
}
