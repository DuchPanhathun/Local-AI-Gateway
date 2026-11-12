#!/usr/bin/env node
// node packaging/tests/real.mjs [--package DIR]
//
// The package itself (its real console and gateways, not stand-ins) through the launcher, in a
// throwaway home folder on a port of its own: it comes up, serves its pages, answers the API, and
// stops. DIR is a built package folder: packaging/local-ai-gateway after `npm run build:package`
// (the default), or a published one unpacked (`npm pack local-ai-gateway`, then tar -xzf: ./package).
//
// Needs Node 20+ and Python 3.11+ on PATH, and the internet (pip installs the gateways' packages).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "../local-ai-gateway/bin/platform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = process.argv.indexOf("--package");
const pkg = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(here, "..", "local-ai-gateway"));
for (const needed of ["bin/cli.mjs", "app.tgz", "gateways"]) {
  if (!existsSync(path.join(pkg, needed))) {
    console.error(`${pkg} is not a built package: no ${needed}.`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const home = mkdtempSync(path.join(tmpdir(), "lag-real-"));
const port = await freePort();
const env = { ...process.env, LOCAL_AI_GATEWAY_HOME: home, PROVIDER_CHECKS: "off" };
const child = spawn(process.execPath, [path.join(pkg, "bin", "cli.mjs"), "--no-open", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
let exit = null;
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve((exit = { code, signal }))));

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  -> ${detail}`}`);
const down = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then(() => false, () => true);

try {
  console.log(`system: ${process.platform} ${process.arch}, node ${process.version}, package ${pkg}, home ${home}`);
  const end = Date.now() + 600_000;
  while (!/Local AI Gateway is running/.test(output)) {
    if (exit) throw new Error(`the launcher stopped early:\n${output}`);
    if (Date.now() > end) throw new Error(`the launcher was not ready in time:\n${output}`);
    await sleep(500);
  }
  const base = `http://127.0.0.1:${port}`;
  const key = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).ownerKey;
  const auth = { Authorization: `Bearer ${key}` };

  const page = await fetch(`${base}/`);
  check("the console's page loads", page.status === 200 && (await page.text()).includes("<html"), `status ${page.status}`);
  check("the documents page loads", (await fetch(`${base}/documents`)).status === 200);
  const session = await (await fetch(`${base}/api/session`)).json();
  check("it is the local edition", session.local === true, JSON.stringify(session));

  // The image optimizer is the one part of Next that needs a compiled module, left out of the package.
  const image = await fetch(`${base}/_next/image?url=%2Ffile.svg&w=64&q=75`);
  await image.arrayBuffer();
  check("the server survives an image-optimizer request", (await fetch(`${base}/api/session`)).status === 200);

  const providers = await fetch(`${base}/api/providers`, { headers: auth });
  const body = await providers.json().catch(() => ({}));
  check("the console reaches the CLI gateway (/api/providers)", providers.status === 200, `status ${providers.status}`);
  console.log("providers as the console sees them:", JSON.stringify(Object.fromEntries(Object.entries(body.setup ?? {}).map(([name, s]) => [name, s.status]))));
  check("and refuses a caller without the key", (await fetch(`${base}/api/providers`)).status === 401);

  const gatewayLog = readFileSync(path.join(home, "logs", "local-agent-gateway.log"), "utf8");
  check("the gateway answered the console", /GET \/health HTTP\/1\.1" 200/.test(gatewayLog), gatewayLog.slice(-300));
  check("no Python traceback in the gateway's log", !/Traceback/.test(gatewayLog), gatewayLog.slice(-600));

  // Stopped the way each system allows: Ctrl+C where a program can be sent it, taskkill where it can't.
  if (process.platform === "win32") {
    killTree(child);
  } else {
    child.kill("SIGINT");
    const stopped = await Promise.race([done, sleep(30_000).then(() => null)]);
    check("Ctrl+C stops the launcher cleanly", stopped?.code === 0, JSON.stringify(stopped));
    check("and removes run.json", !existsSync(path.join(home, "run.json")));
  }
  await done;
  await sleep(1500);
  check("the console is down once it has stopped", await down(`${base}/api/session`));
} catch (err) {
  results.push(`FAIL ${err.message}`);
} finally {
  if (exit === null) killTree(child);
  console.log(results.join("\n"));
  const failed = results.some((line) => line.startsWith("FAIL"));
  if (failed) {
    console.log(`\n--- launcher output ---\n${output.slice(-3000)}`);
    for (const name of ["local-agent-gateway", "console"]) {
      const log = path.join(home, "logs", `${name}.log`);
      if (existsSync(log)) console.log(`\n--- ${name}.log ---\n${readFileSync(log, "utf8").slice(-2000)}`);
    }
  }
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  process.exit(failed ? 1 : 0);
}
