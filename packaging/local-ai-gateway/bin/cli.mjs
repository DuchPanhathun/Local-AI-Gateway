#!/usr/bin/env node
// local-ai-gateway: runs the console and the gateways on this computer, in front of
// the user's own AI tools (Claude Code, Codex, Gemini CLI, Antigravity, and the
// ChatGPT, Grok and MiMo websites), signed in as them. Nothing leaves the machine
// except what those tools themselves send, and everything listens on 127.0.0.1 only.
//
//   npx local-ai-gateway            start it (the first run sets itself up)
//   npx local-ai-gateway key        show the link and key again
//   npx local-ai-gateway web-signin sign in to ChatGPT, Grok and MiMo in the gateway's Chrome
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  browserCommand,
  expandHome,
  findChrome as locateChrome,
  findCli as locateCli,
  findPython as locatePython,
  killTree,
  pythonHint,
  tarCommand,
  terminate,
  venvHint,
  venvPython,
} from "./platform.mjs";

const WINDOWS = process.platform === "win32";
// Python on Windows reads and writes text in the ANSI code page unless told otherwise; the gateways' logs
// and the CLIs' output are UTF-8.
const PYTHON_ENV = WINDOWS ? { PYTHONUTF8: "1" } : {};
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")).version;
const HOME = path.resolve(process.env.LOCAL_AI_GATEWAY_HOME || path.join(homedir(), ".local-ai-gateway"));
const RUN_FILE = path.join(HOME, "run.json");

const BASE_REQS = ["fastapi>=0.115", "uvicorn>=0.30", "pydantic-settings>=2.7", "psutil>=6.0"];
const WEB_REQS = ["playwright>=1.55"]; // drives the system Chrome; no browser download

const CLIS = [
  { name: "Claude Code", cmd: "claude", env: "CLAUDE_BIN", howto: "https://docs.claude.com/claude-code" },
  { name: "Codex", cmd: "codex", env: "CODEX_BIN", howto: "https://github.com/openai/codex" },
  { name: "Gemini CLI", cmd: "gemini", env: "GEMINI_BIN", howto: "https://github.com/google-gemini/gemini-cli" },
  { name: "Antigravity", cmd: "agy", env: "ANTIGRAVITY_BIN", also: [".gemini/bin/agy", ".local/bin/agy"], howto: "Google's Antigravity CLI" },
];

const WEB_NOTICE = `
The websites (ChatGPT, Grok, MiMo) have no API. The web gateway types each prompt into the
site in its own Chrome window, signed in to YOUR accounts, and reads the answer back.

  - Those sites' terms don't allow automated use. Your accounts could be limited or banned.
    Keep it to your own, light use.
  - It breaks when a site changes its page, and it won't get past a Cloudflare check or a
    sign-in page: you do that in the Chrome window.
  - While it runs, any program on this computer can control that Chrome (and the accounts
    signed in to it) through its debugging port.
`;

const HELP = `local-ai-gateway ${VERSION}

Usage:
  local-ai-gateway [start] [options]   start the console and gateways (first run sets up)
  local-ai-gateway key                 show the console link and API key
  local-ai-gateway web-signin          open the gateway's Chrome to sign in to ChatGPT, Grok, MiMo

Options:
  --port N            console port (default 3000; another is used if it's busy)
  --allow DIR         let the CLIs read and work in DIR (repeatable; remembered)
  --web               also run the ChatGPT/Grok/MiMo gateway (asks you to accept the risks first)
  --no-web            stop running it
  --accept-web-risks  accept the web notice without asking
  --no-open           don't open the browser
  -h, --help          this text

Needs Node 20+, Python 3.11+ and, for --web, Google Chrome. Linux, macOS and Windows.
Everything lives in ${HOME} (set LOCAL_AI_GATEWAY_HOME to change it).
`;

const say = (...lines) => console.log(...lines);
function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const a = { command: "start", port: 3000, open: true, web: undefined, acceptWebRisks: false, allow: [] };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) a.command = rest.shift();
  while (rest.length) {
    const x = rest.shift();
    if (x === "--port") a.port = Number(rest.shift());
    else if (x === "--allow") a.allow.push(rest.shift() ?? "");
    else if (x === "--no-open") a.open = false;
    else if (x === "--web") a.web = true;
    else if (x === "--no-web") a.web = false;
    else if (x === "--accept-web-risks") a.acceptWebRisks = true;
    else if (x === "-h" || x === "--help") a.command = "help";
    else if (x === "-v" || x === "--version") a.command = "version";
    else die(`Unknown option ${x}. Try --help.`);
  }
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) die("--port needs a number from 1 to 65535.");
  return a;
}

// ---------------------------------------------------------------------------
// What's kept between runs: fresh keys made here, never shared with anyone
// ---------------------------------------------------------------------------

function loadConfig() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const file = path.join(HOME, "config.json");
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const key = () => randomBytes(32).toString("base64url");
  cfg = { version: 1, web: false, allow: [], lastPort: 3000, ...cfg };
  for (const name of ["ownerKey", "agentToken", "webToken"]) cfg[name] ||= key();
  const save = () => {
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  };
  save();
  return { cfg, save };
}

function consoleLink(cfg, port) {
  return `http://127.0.0.1:${port}/#key=${cfg.ownerKey}`;
}

// KEY=value lines the user may add for the cloud providers (Groq, Cerebras, SEA-LION).
function loadUserEnv() {
  const file = path.join(HOME, "env");
  if (!existsSync(file)) {
    writeFileSync(
      file,
      "# Optional: API keys for cloud providers, one per line, then restart. Not needed for your own CLIs.\n" +
        "# GROQ_API_KEY1=\n# CEREBRAS_API_KEY1=\n# SEA_LION_API_KEY1=\n",
      { mode: 0o600 },
    );
  }
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

// ---------------------------------------------------------------------------
// What this computer needs
// ---------------------------------------------------------------------------

// Where programs are, and how they start, differs by system: see platform.mjs.
const findChrome = () => locateChrome({ home: homedir() });
const findCli = (cli) => locateCli(cli, { home: homedir() });

function ensureVenv(python, withWeb) {
  const venv = path.join(HOME, "venv");
  const vpy = venvPython(venv);
  if (!existsSync(vpy)) {
    say("Creating a private Python environment (first run only)...");
    const r = spawnSync(python.cmd, [...python.args, "-m", "venv", venv], { stdio: "inherit" });
    if (r.status !== 0) {
      rmSync(venv, { recursive: true, force: true });
      die(`Couldn't create a Python environment. ${venvHint()}`);
    }
  }
  const wanted = [...BASE_REQS, ...(withWeb ? WEB_REQS : [])];
  const marker = path.join(venv, ".lag-packages.json");
  let have = [];
  try {
    have = JSON.parse(readFileSync(marker, "utf8"));
  } catch {}
  if (wanted.some((r) => !have.includes(r))) {
    say("Installing the gateways' Python packages (first run only, needs the internet)...");
    const r = spawnSync(vpy, ["-m", "pip", "install", "--disable-pip-version-check", "-q", ...wanted], { stdio: "inherit" });
    if (r.status !== 0) die("pip couldn't install the packages. Check your connection and run the command again.");
    writeFileSync(marker, JSON.stringify([...new Set([...have, ...wanted])]));
  }
  return vpy;
}

// Windows refuses to rename a folder while something (a virus scanner, looking at the files
// just written) has one of them open: try again for a few seconds.
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (!WINDOWS || !["EPERM", "EBUSY", "EACCES"].includes(err.code) || attempt >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

// The console is shipped as one archive (npm drops node_modules folders from a package).
function ensureConsole() {
  const dir = path.join(HOME, "app", VERSION);
  if (existsSync(path.join(dir, "server.js"))) return dir;
  const archive = path.join(PKG, "app.tgz");
  if (!existsSync(archive)) die("This install is missing its console (app.tgz). Reinstall the package.");
  say("Unpacking the console (first run only)...");
  const part = `${dir}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  const r = spawnSync(tarCommand(), ["-xzf", archive, "-C", part], { stdio: "inherit" });
  if (r.status !== 0) die("Couldn't unpack the console. Is `tar` installed?");
  renameWithRetry(part, dir);
  return dir;
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freePort(preferred) {
  if (await isFree(preferred)) return preferred;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function confirmWebRisks(args) {
  say(WEB_NOTICE);
  if (args.acceptWebRisks) return true;
  if (!process.stdin.isTTY) die("Add --accept-web-risks to use --web without a keyboard.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Run the web gateway anyway? [y/N] ")).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const children = [];
let stopping = false;

function tail(file, lines = 8) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function launch(name, command, args, { cwd, env }) {
  mkdirSync(path.join(HOME, "logs"), { recursive: true });
  const logFile = path.join(HOME, "logs", `${name}.log`);
  const fd = openSync(logFile, "a");
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  children.push({ name, child });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    say(`\n${name} stopped unexpectedly (${signal ?? `exit ${code}`}). Its log, ${logFile}:\n${tail(logFile)}`);
    shutdown(1);
  });
  return logFile;
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

// `fromConsole`: the stop came from Ctrl+C (or closing the window), not from one of the
// children dying. On Windows there is no SIGTERM to ask them with, but Ctrl+C has reached
// every program sharing the console already, so they get time to close themselves down
// (the gateways end their CLIs); if one of them died instead, the rest are ended right away.
function shutdown(code = 0, { fromConsole = false } = {}) {
  if (stopping) return;
  stopping = true;
  say("\nStopping...");
  for (const { child } of children) terminate(child);
  const force = setTimeout(
    () => {
      for (const { child } of children) if (!exited(child)) killTree(child);
      rmSync(RUN_FILE, { force: true });
      process.exit(code);
    },
    WINDOWS && !fromConsole ? 0 : 8000,
  );
  Promise.all(children.map(({ child }) => new Promise((resolve) => (exited(child) ? resolve() : child.once("exit", resolve))))).then(() => {
    clearTimeout(force);
    rmSync(RUN_FILE, { force: true });
    process.exit(code);
  });
}

async function waitReady(name, url, headers, logFile) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !stopping) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  if (!stopping) {
    say(`\n${name} didn't come up. Its log, ${logFile}:\n${tail(logFile)}`);
    shutdown(1);
  }
  await new Promise(() => {}); // shutting down
}

function openBrowser(url) {
  const { cmd, args } = browserCommand(url);
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {}
}

function alreadyRunning() {
  try {
    const { pid, port } = JSON.parse(readFileSync(RUN_FILE, "utf8"));
    process.kill(pid, 0);
    return { pid, port };
  } catch {
    return null;
  }
}

function checkPlatform() {
  if (!["linux", "darwin", "win32"].includes(process.platform)) {
    die(`Local AI Gateway runs on Linux, macOS and Windows (this is ${process.platform}).`);
  }
  if (Number(process.versions.node.split(".")[0]) < 20) die(`Node 20 or newer is needed (this is ${process.versions.node}).`);
}

async function start(args) {
  checkPlatform();
  const { cfg, save } = loadConfig();

  const running = alreadyRunning();
  if (running) {
    say(`Local AI Gateway is already running (pid ${running.pid}).\n\n  ${consoleLink(cfg, running.port)}\n`);
    if (args.open) openBrowser(consoleLink(cfg, running.port));
    return;
  }

  const python = locatePython();
  if (!python) die(`Python 3.11 or newer is needed for the gateways. ${pythonHint()}, then run this again.`);

  if (args.web === true && !cfg.web) {
    if (!(await confirmWebRisks(args))) die("Not enabling the web gateway.");
    if (!findChrome()) die("The web gateway needs Google Chrome (or Chromium), and none was found.");
    cfg.web = true;
  } else if (args.web === false) cfg.web = false;
  const chrome = cfg.web ? findChrome() : null;
  if (cfg.web && !chrome) die("The web gateway needs Google Chrome (or Chromium), and none was found. Run with --no-web to turn it off.");

  const workspace = path.join(HOME, "workspace");
  const stateDir = path.join(HOME, "state");
  const runDir = path.join(HOME, "run"); // where the gateways start: no stray .env to read
  for (const dir of [workspace, stateDir, runDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const dir of args.allow) {
    const full = path.resolve(expandHome(dir, homedir()));
    if (!existsSync(full) || !statSync(full).isDirectory()) die(`--allow ${dir}: that folder doesn't exist.`);
    if (full.includes(",")) die(`--allow ${dir}: the gateway keeps its folders in a comma-separated list, so a folder with a comma in its path can't be used.`);
    if (!cfg.allow.includes(full)) cfg.allow.push(full);
  }
  const allow = [workspace, ...cfg.allow.filter((dir) => existsSync(dir))];

  const vpy = ensureVenv(python, cfg.web);
  const appDir = ensureConsole();
  const userEnv = loadUserEnv();

  const bins = {};
  const found = CLIS.map((cli) => ({ cli, file: findCli(cli) }));
  for (const { cli, file } of found) if (file) bins[cli.env] = file;

  const consolePort = await freePort(args.port);
  const agentPort = await freePort(8787);
  const webPort = cfg.web ? await freePort(8789) : null;
  const chromePort = process.env.LOCAL_AI_GATEWAY_CHROME_PORT || "9223";
  cfg.lastPort = consolePort;
  save();

  const agentLog = launch("local-agent-gateway", vpy, ["-m", "local_agent_gateway"], {
    cwd: runDir,
    env: {
      ...process.env,
      ...PYTHON_ENV,
      ...bins,
      PYTHONPATH: path.join(PKG, "gateways", "local-agent", "src"),
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(agentPort),
      GATEWAY_TOKEN: cfg.agentToken,
      WORKDIR_ALLOWLIST: allow.join(","),
      DEFAULT_WORKDIR: workspace,
    },
  });

  let webLog = null;
  if (cfg.web) {
    webLog = launch("chatgpt-web-gateway", vpy, ["-m", "chatgpt_web_gateway"], {
      cwd: runDir,
      env: {
        ...process.env,
        ...PYTHON_ENV,
        PYTHONPATH: path.join(PKG, "gateways", "chatgpt-web", "src"),
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: String(webPort),
        GATEWAY_TOKEN: cfg.webToken,
        CHROME_BIN: chrome,
        CHROME_PROFILE_DIR: path.join(HOME, "chrome-profile"),
        CHROME_DEBUG_PORT: chromePort,
      },
    });
  }

  const consoleLog = launch("console", process.execPath, [path.join(appDir, "server.js")], {
    cwd: appDir,
    env: {
      ...userEnv,
      ...process.env,
      NODE_ENV: "production",
      PORT: String(consolePort),
      HOSTNAME: "127.0.0.1",
      APP_API_KEY: cfg.ownerKey,
      LOCAL_EDITION: "1",
      PROVIDER_CHECKS: process.env.PROVIDER_CHECKS || "off", // test chats spend plan usage: on request only
      AI_THUN_STATE_DIR: stateDir,
      LOCAL_AGENT_URL: `http://127.0.0.1:${agentPort}`,
      LOCAL_AGENT_TOKEN: cfg.agentToken,
      CHATGPT_WEB_URL: `http://127.0.0.1:${webPort ?? 8789}`,
      CHATGPT_WEB_TOKEN: cfg.webToken,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  // Windows has no SIGTERM; closing the window is SIGHUP there, and Ctrl+Break is SIGBREAK.
  for (const signal of WINDOWS ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => shutdown(0, { fromConsole: true }));
  }

  say(`Starting Local AI Gateway ${VERSION}...`);
  await waitReady("local-agent-gateway", `http://127.0.0.1:${agentPort}/health`, { Authorization: `Bearer ${cfg.agentToken}` }, agentLog);
  if (cfg.web) await waitReady("chatgpt-web-gateway", `http://127.0.0.1:${webPort}/health`, { Authorization: `Bearer ${cfg.webToken}` }, webLog);
  await waitReady("console", `http://127.0.0.1:${consolePort}/api/session`, {}, consoleLog);
  writeFileSync(RUN_FILE, JSON.stringify({ pid: process.pid, port: consolePort }), { mode: 0o600 });

  const link = consoleLink(cfg, consolePort);
  say(`
Local AI Gateway is running. Ctrl+C here stops it.

  Console  ${link}
  API      http://127.0.0.1:${consolePort}/api/chat   (Authorization: Bearer <your key>)
  Key      ${cfg.ownerKey}      (\`local-ai-gateway key\` shows it again)

Your own tools, found on this computer:`);
  for (const { cli, file } of found) {
    say(file ? `  ${cli.name.padEnd(12)} found    ${file}` : `  ${cli.name.padEnd(12)} not found (install it, and sign in to it, the way its maker describes: ${cli.howto})`);
  }
  say(`
The CLIs can read and work in: ${allow.join(", ")}
  add more with --allow DIR (they can do what a CLI does there, so choose carefully).
${cfg.web ? `Websites: run \`local-ai-gateway web-signin\` once to sign in to ChatGPT, Grok and MiMo.` : `Websites (ChatGPT, Grok, MiMo): off. Turn on with --web.`}
Logs: ${path.join(HOME, "logs")}
`);
  if (args.open) openBrowser(link);
}

function showKey() {
  const { cfg } = loadConfig();
  const running = alreadyRunning();
  const link = consoleLink(cfg, running?.port ?? cfg.lastPort);
  say(`\nConsole  ${link}\nAPI key  ${cfg.ownerKey}\n${running ? "" : "(not running right now; start it with: local-ai-gateway)\n"}`);
}

function webSignin() {
  checkPlatform();
  const { cfg } = loadConfig();
  if (!cfg.web) die("The web gateway isn't turned on. Run `local-ai-gateway --web` first.");
  const chrome = findChrome();
  if (!chrome) die("Google Chrome (or Chromium) wasn't found.");
  const vpy = venvPython(path.join(HOME, "venv"));
  if (!existsSync(vpy)) die("Run `local-ai-gateway --web` once first, to set up.");
  const r = spawnSync(vpy, ["-m", "chatgpt_web_gateway", "signin"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...PYTHON_ENV,
      PYTHONPATH: path.join(PKG, "gateways", "chatgpt-web", "src"),
      GATEWAY_TOKEN: cfg.webToken,
      CHROME_BIN: chrome,
      CHROME_PROFILE_DIR: path.join(HOME, "chrome-profile"),
      CHROME_DEBUG_PORT: process.env.LOCAL_AI_GATEWAY_CHROME_PORT || "9223",
    },
  });
  process.exit(r.status ?? 1);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "help") say(HELP);
else if (args.command === "version") say(VERSION);
else if (args.command === "key") showKey();
else if (args.command === "web-signin") webSignin();
else if (args.command === "start") await start(args);
else die(`Unknown command ${args.command}. Try --help.`);
