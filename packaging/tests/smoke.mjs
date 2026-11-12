#!/usr/bin/env node
// node packaging/tests/smoke.mjs
//
// The launcher, start to stop, on this system. The package it runs is made of stand-ins (a
// "console" and a "gateway" that only answer, and start a program of their own), so this
// needs no build and none of the gateways' source. It checks what differs between systems:
// the Python environment's layout, unpacking the console with the system's tar, finding
// ports, and that stopping the launcher stops everything it started, grandchildren included.
//
// Needs Node 20+ and Python 3.11+ on PATH, and the internet (pip installs the gateways' packages).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tarCommand } from "../local-ai-gateway/bin/platform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "local-ai-gateway");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

async function until(what, ms, check) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// ---------------------------------------------------------------------------
// The stand-in package
// ---------------------------------------------------------------------------

const work = mkdtempSync(path.join(tmpdir(), "lag-smoke-"));
const pkg = path.join(work, "pkg");
const home = path.join(work, "home");
mkdirSync(pkg, { recursive: true });
cpSync(path.join(source, "bin"), path.join(pkg, "bin"), { recursive: true });
cpSync(path.join(source, "package.json"), path.join(pkg, "package.json"));

// The console: answers /api/session, and says which process it is.
const consoleDir = path.join(work, "console");
mkdirSync(consoleDir, { recursive: true });
writeFileSync(
  path.join(consoleDir, "server.js"),
  `const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(path.join(process.env.AI_THUN_STATE_DIR, "console.pid"), String(process.pid));
http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end('{"signedIn":false,"local":true}'); })
  .listen(Number(process.env.PORT), process.env.HOSTNAME);
`,
);
const tar = tarCommand();
const packed = spawnSync(tar, ["-czf", path.join(pkg, "app.tgz"), "-C", consoleDir, "."], { stdio: "inherit" });
if (packed.status !== 0) throw new Error(`${tar} could not make the console archive`);

// The gateway: answers any GET, starts a grandchild (like a CLI starting a shell), ends it when asked to
// stop (as the real one ends its CLIs), and dies without a word when told to (a file named "die"), the
// way a crashed gateway would.
const gatewaySrc = path.join(pkg, "gateways", "local-agent", "src", "local_agent_gateway");
mkdirSync(gatewaySrc, { recursive: true });
writeFileSync(path.join(gatewaySrc, "__init__.py"), "");
writeFileSync(
  path.join(gatewaySrc, "__main__.py"),
  `import http.server, os, pathlib, signal, subprocess, sys, threading, time

here = pathlib.Path.cwd()
(here / "gateway.pid").write_text(str(os.getpid()))
grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
(here / "grandchild.pid").write_text(str(grandchild.pid))

def stop(*_):
    grandchild.kill()
    os._exit(0)

for name in ("SIGINT", "SIGTERM"):
    if hasattr(signal, name):
        signal.signal(getattr(signal, name), stop)

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", int(os.environ["GATEWAY_PORT"])), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
while not (here / "die").exists():
    time.sleep(0.1)
os._exit(3)
`,
);

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const env = { ...process.env, LOCAL_AI_GATEWAY_HOME: home, PROVIDER_CHECKS: "off" };
const pidFile = (...parts) => path.join(home, ...parts);
const readPid = (...parts) => (existsSync(pidFile(...parts)) ? Number(readFileSync(pidFile(...parts), "utf8")) : null);

function launch(port) {
  const child = spawn(process.execPath, [path.join(pkg, "bin", "cli.mjs"), "--no-open", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, output: "", exit: null };
  child.stdout.on("data", (chunk) => (run.output += chunk));
  child.stderr.on("data", (chunk) => (run.output += chunk));
  run.done = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      run.exit = { code, signal };
      resolve(run.exit);
    }),
  );
  return run;
}

const processes = () => ({
  launcher: null,
  gateway: readPid("run", "gateway.pid"),
  grandchild: readPid("run", "grandchild.pid"),
  console: readPid("state", "console.pid"),
});

let failed = false;
const checks = [];
function check(name, ok, detail = "") {
  checks.push(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed = true;
}

async function untilGone(pids, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end && pids.some(alive)) await sleep(200);
  return pids.filter(alive);
}

let current = null;
const started = new Set(); // every process this test has seen the stand-ins start, to clean up after
try {
  console.log(`system: ${process.platform} ${process.arch}, node ${process.version}, work folder ${work}`);

  // 1. First start: sets itself up, comes up, and says how to get in.
  const port = await freePort();
  current = launch(port);
  await until("the launcher to say it is running", 240_000, () => (/Local AI Gateway is running/.test(current.output) ? true : current.exit ? Promise.reject(new Error(`the launcher stopped early:\n${current.output}`)) : false));
  const answer = await fetch(`http://127.0.0.1:${port}/api/session`);
  check("the console answers on the port it was given", answer.status === 200, `status ${answer.status}`);
  check("the link carries a key", /#key=[\w-]{20,}/.test(current.output));
  const state = processes();
  Object.values(state).forEach((pid) => pid && started.add(pid));
  check("the console, the gateway and its child are all running", [state.gateway, state.grandchild, state.console].every((pid) => pid && alive(pid)), JSON.stringify(state));
  const run = JSON.parse(readFileSync(pidFile("run.json"), "utf8"));
  check("it recorded itself in run.json", run.pid === current.child.pid && run.port === port, JSON.stringify(run));

  // 2. `key` shows the same link again, without starting anything.
  const key = spawnSync(process.execPath, [path.join(pkg, "bin", "cli.mjs"), "key"], { env, encoding: "utf8" });
  check("`key` shows the link", key.status === 0 && /#key=/.test(key.stdout), key.stdout + key.stderr);

  // 3. A gateway that dies takes the console down with it. A crashed gateway can't end its own children: on
  // Windows the launcher does (taskkill /T), elsewhere it's the gateway's job, so only there is it checked.
  writeFileSync(pidFile("run", "die"), "");
  const exit = await Promise.race([current.done, sleep(60_000).then(() => null)]);
  check("the launcher stops when the gateway dies, with a failing status", exit !== null && exit.code === 1, JSON.stringify(exit));
  const direct = await untilGone([state.gateway, state.console]);
  check("the gateway and the console are gone", direct.length === 0, `still running: ${direct}`);
  if (process.platform === "win32") {
    const orphan = await untilGone([state.grandchild]);
    check("and so is what the gateway had started (taskkill /T)", orphan.length === 0, `still running: ${orphan}`);
  }
  check("run.json is gone", !existsSync(pidFile("run.json")));
  rmSync(pidFile("run", "die"), { force: true });

  // 4. Second start, from the setup already made, stopped the way a person stops it (Ctrl+C).
  // Windows can't send Ctrl+C to one program from another, so there it is tried by hand.
  if (process.platform !== "win32") {
    const second = await freePort();
    current = launch(second);
    await until("the second start", 120_000, () => (/Local AI Gateway is running/.test(current.output) ? true : current.exit ? Promise.reject(new Error(`the second start stopped early:\n${current.output}`)) : false));
    const again = processes();
    Object.values(again).forEach((pid) => pid && started.add(pid));
    check("the second start found its setup (no pip, no unpacking)", !/Installing the gateways|Unpacking the console/.test(current.output.split("Local AI Gateway is running")[0]));
    current.child.kill("SIGINT");
    const stopped = await Promise.race([current.done, sleep(30_000).then(() => null)]);
    check("Ctrl+C stops it cleanly", stopped !== null && stopped.code === 0, JSON.stringify(stopped));
    const rest = await untilGone([again.gateway, again.grandchild, again.console].filter(Boolean));
    check("and everything it started", rest.length === 0, `still running: ${rest}`);
  }
} catch (err) {
  failed = true;
  checks.push(`FAIL ${err.message}`);
} finally {
  for (const pid of started) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  if (current?.child && current.exit === null) current.child.kill("SIGKILL");
  console.log(checks.join("\n"));
  if (failed && current) console.log(`\n--- launcher output ---\n${current.output}`);
  if (failed) {
    for (const name of ["local-agent-gateway", "console"]) {
      const log = pidFile("logs", `${name}.log`);
      if (existsSync(log)) console.log(`\n--- ${name}.log ---\n${readFileSync(log, "utf8").slice(-2000)}`);
    }
  }
  await sleep(500);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exit(failed ? 1 : 0);
