// The public door: the only way in from the internet. Tailscale Funnel sends
// public traffic here (never to the gateway's own port), and Vercel, at
// thun-murex.duchpanhathun.com, adds a secret header to every request it
// forwards. Requests with the secret go on to the gateway, marked as public
// (x-thun-public: 1) with the visitor's address (x-real-ip), so the gateway
// applies its internet rules; anything else gets 403. Responses stream
// through as they come (Server-Sent Events included).
//
// Only ORIGIN_SECRET is read from the gateway's .env, nothing else in it.
// No dependencies. Runs as the thun-murex-door user service.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function secretFromEnvFile() {
  try {
    const line = readFileSync(join(here, "..", ".env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("ORIGIN_SECRET="));
    return line?.slice("ORIGIN_SECRET=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  } catch {
    return undefined;
  }
}

const SECRET = process.env.ORIGIN_SECRET || secretFromEnvFile();
const PORT = Number(process.env.DOOR_PORT || 3001);
const GATEWAY = { host: "127.0.0.1", port: Number(process.env.GATEWAY_PORT || 3000) };
// DOOR_DEBUG=1: log where each request says it's from (addresses and hosts;
// never the secret, keys or cookies), to see what Vercel and Funnel pass on.
const DEBUG = process.env.DOOR_DEBUG === "1";

if (!SECRET || SECRET.length < 32) {
  console.error("ORIGIN_SECRET (32 characters or more) isn't set, in the environment or the gateway's .env: refusing to start.");
  process.exit(1);
}

const digest = (s) => createHash("sha256").update(s).digest();
const WANTED = digest(SECRET);
const hasSecret = (value) => typeof value === "string" && timingSafeEqual(digest(value), WANTED);

// Per connection, not per request: not passed on.
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization"]);

const refuse = (res, status, error) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error }));

const server = http.createServer((req, res) => {
  if (DEBUG) {
    const h = req.headers;
    console.log(JSON.stringify({ method: req.method, path: req.url, secret: hasSecret(h["x-origin-secret"]), host: h.host, "x-forwarded-host": h["x-forwarded-host"], "x-real-ip": h["x-real-ip"], "x-forwarded-for": h["x-forwarded-for"], origin: h.origin, "sec-fetch-site": h["sec-fetch-site"] }));
  }
  if (!hasSecret(req.headers["x-origin-secret"])) return refuse(res, 403, "Forbidden");

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP.has(name) && name !== "x-origin-secret" && name !== "x-thun-public") headers[name] = value;
  }
  // Vercel sets x-real-ip to the visitor's address, and Funnel passes it on;
  // it's trusted because the secret says the request came through Vercel.
  // (Not x-forwarded-for: Funnel replaces that with Vercel's own address.)
  headers["x-real-ip"] = String(req.headers["x-real-ip"] ?? "").trim() || "unknown";
  headers["x-thun-public"] = "1";

  const upstream = http.request({ ...GATEWAY, method: req.method, path: req.url, headers }, (reply) => {
    const out = {};
    for (const [name, value] of Object.entries(reply.headers)) if (!HOP.has(name)) out[name] = value;
    // Nothing is kept in Vercel's cache but the build's own files, whose names
    // change with their contents.
    if (!req.url.startsWith("/_next/static/")) out["cache-control"] = "no-store";
    res.writeHead(reply.statusCode ?? 502, out);
    reply.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) refuse(res, 502, "The gateway isn't answering.");
    else res.destroy();
  });
  // The visitor left before the answer was done: stop the gateway's work too.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

server.headersTimeout = 30_000;
server.requestTimeout = 10 * 60_000; // for receiving a request (an upload), not for answering it
server.listen(PORT, "127.0.0.1", () => console.log(`Public door on 127.0.0.1:${PORT}, to the gateway on ${GATEWAY.host}:${GATEWAY.port}`));
