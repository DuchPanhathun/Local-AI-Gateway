#!/usr/bin/env node
// Builds the `npx local-ai-gateway` package (packaging/local-ai-gateway) from this
// repo and the two gateways, then packs it:
//
//   node scripts/build-package.mjs [--local-agent DIR] [--chatgpt-web DIR]
//
// The gateways default to ../local-agent and ../chatgpt-web. The console is built
// with a clean environment (no Supabase address, no keys) in its own .next-local
// folder, so what ships has none of this server's settings, and a scan at the end
// fails the build if any secret from a local .env file turns up in the package.
//
// The package is MIT (packaging/local-ai-gateway/LICENSE), and ships the licenses of the third-party code in it
// (THIRD_PARTY_NOTICES.md, made here by third-party-notices.mjs).
//
// The package runs on Linux, macOS and Windows, so what ships must hold no compiled
// code (the build fails if the console archive does), and the gateways get the changes
// in packaging/patches applied to their copy (they are separate projects; see there).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeThirdPartyNotices } from "./third-party-notices.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgDir = path.join(root, "packaging", "local-ai-gateway");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return path.resolve(i >= 0 ? process.argv[i + 1] : fallback);
}
const gateways = {
  "local-agent": arg("--local-agent", path.join(root, "..", "local-agent")),
  "chatgpt-web": arg("--chatgpt-web", path.join(root, "..", "chatgpt-web")),
};

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { stdio: "inherit", cwd: root, ...options });
  if (r.status !== 0) {
    console.error(`\n${command} ${args.join(" ")} failed.`);
    process.exit(r.status ?? 1);
  }
}

for (const [name, dir] of Object.entries(gateways)) {
  if (!existsSync(path.join(dir, "src")) || !existsSync(path.join(dir, "pyproject.toml"))) {
    console.error(`Can't find the ${name} source at ${dir}. Pass --${name} DIR.`);
    process.exit(1);
  }
}

// `next build` rewrites tsconfig.json (it adds the build folder's type files and reformats
// the file). Put it back however this script ends.
const tsconfig = path.join(root, "tsconfig.json");
const tsconfigBefore = readFileSync(tsconfig, "utf8");
process.on("exit", () => writeFileSync(tsconfig, tsconfigBefore));

// 1. The console, built clean.
console.log("== Building the console (standalone, clean environment)");
rmSync(path.join(root, ".next-local"), { recursive: true, force: true });
run("npx", ["next", "build"], {
  env: {
    ...process.env,
    LOCAL_EDITION_BUILD: "1",
    NEXT_PUBLIC_SUPABASE_URL: "", // set, so a .env file can't fill them in: no accounts in this edition
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});

// 2. Assemble: the console as one archive, the gateways' source beside it.
console.log("== Assembling the package");
const standalone = path.join(root, ".next-local", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("The standalone build has no server.js.");
  process.exit(1);
}
// The standalone build copies in the project's .env files (the keys of whoever built it!) and the
// extension download. Neither belongs in a package for other people.
for (const name of readdirSync(standalone)) if (name.startsWith(".env")) rmSync(path.join(standalone, name), { force: true });
rmSync(path.join(standalone, "extension"), { recursive: true, force: true });
// sharp (and its libvips) is the one compiled module in the build: Next's image optimizer, for next/image,
// which the console doesn't use. What it ships is for the system that built it, which would make the package
// run only there. Next loads it only when /_next/image is asked for.
for (const name of ["sharp", "@img"]) rmSync(path.join(standalone, "node_modules", name), { recursive: true, force: true });
cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
cpSync(path.join(root, ".next-local", "static"), path.join(standalone, ".next-local", "static"), { recursive: true });
// The licenses of the third-party code in the console (its build copies the code without them).
const notices = writeThirdPartyNotices({ root, standalone, out: path.join(pkgDir, "THIRD_PARTY_NOTICES.md") });
console.log(`  third-party notices for ${notices.packages} packages${notices.fonts ? " and the Geist fonts" : ""}${notices.problems.length ? `; without a license file: ${notices.problems.join(", ")}` : ""}`);
rmSync(path.join(pkgDir, "app.tgz"), { force: true });
run("tar", ["-czf", path.join(pkgDir, "app.tgz"), "-C", standalone, "."]);

rmSync(path.join(pkgDir, "gateways"), { recursive: true, force: true });
for (const [name, dir] of Object.entries(gateways)) {
  const out = path.join(pkgDir, "gateways", name);
  mkdirSync(out, { recursive: true });
  cpSync(path.join(dir, "src"), path.join(out, "src"), { recursive: true, filter: (file) => !file.includes("__pycache__") });
  cpSync(path.join(dir, "pyproject.toml"), path.join(out, "pyproject.toml"));
  if (existsSync(path.join(dir, "README.md"))) cpSync(path.join(dir, "README.md"), path.join(out, "README.md"));
  applyPatch(name, out);
}

// The Windows and macOS changes to a gateway are packaging/patches/<name>.patch, made against its repo root.
// A gateway that already has them is left alone; one the patch no longer fits stops the build.
function applyPatch(name, dir) {
  const patch = path.join(root, "packaging", "patches", `${name}.patch`);
  if (!existsSync(patch)) return;
  // git apply, but not as part of this repo: the ceiling keeps it from finding the .git above.
  const git = (...args) => spawnSync("git", ["apply", ...args, patch], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  const fits = git("--check");
  if (fits.status === 0) {
    const r = git();
    if (r.status !== 0) {
      console.error(r.stderr);
      process.exit(1);
    }
    console.log(`  ${name}: applied packaging/patches/${name}.patch`);
  } else if (git("--reverse", "--check").status === 0) {
    console.log(`  ${name}: already has the changes in packaging/patches/${name}.patch`);
  } else {
    console.error(`\npackaging/patches/${name}.patch doesn't fit the ${name} source at ${gateways[name]}:\n${fits.stderr}`);
    console.error("The gateway changed where the patch changes it: make the patch again against its current source.");
    process.exit(1);
  }
}

// 3. No secret from any .env file here may be in what ships (the console archive is
// unpacked to look inside it).
console.log("== Scanning for secrets");
// A setting that says where something is (CLAUDE_BIN, CHROME_PROFILE_DIR, WORKDIR_ALLOWLIST...) isn't a
// credential, and its value turns up in the package legitimately: as a gateway's own default, or in the docs.
// Only a value that is named like a place AND looks like a path is skipped; a key or token never is.
const PLACE_NAME = /(_BIN|_DIR|_HOME|_PATH|_WORKDIR|_ALLOWLIST)$/i;
const PATH_VALUE = /^(~|\/|[A-Za-z]:[\\/])[\w .~/\\,:-]*$/;
const secrets = new Set();
let places = 0;
for (const dir of [root, ...Object.values(gateways)]) {
  for (const name of readdirSync(dir).filter((f) => f.startsWith(".env") && !f.endsWith(".example"))) {
    for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
      const value = m?.[2].replace(/^(['"])(.*)\1$/, "$2");
      if (!value || value.length < 16 || /^https?:\/\//.test(value)) continue;
      if (PLACE_NAME.test(m[1]) && PATH_VALUE.test(value)) places++;
      else secrets.add(value);
    }
  }
}
const scanDir = path.join(root, ".next-local", "scan");
rmSync(scanDir, { recursive: true, force: true });
mkdirSync(scanDir, { recursive: true });
run("tar", ["-xzf", path.join(pkgDir, "app.tgz"), "-C", scanDir]);
// The console runs on every system, so it can't hold compiled code (it would be for the system that built it).
const compiled = readdirSync(scanDir, { recursive: true }).filter((file) => /\.(node|so(\.\d+)*|dylib|dll|exe)$/i.test(String(file)));
if (compiled.length) {
  console.error(`\nThe console archive has compiled code, which would only run on the system that built it:\n  ${compiled.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
console.log("  the console archive holds no compiled code");
let hits = 0;
let files = 0;
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile() && statSync(file).size < 8_000_000) {
      files++;
      const text = readFileSync(file, "latin1");
      for (const secret of secrets) {
        if (text.includes(secret)) {
          hits++;
          console.error(`  LEAK: a secret from a .env file is in ${path.relative(scanDir, file)}`);
        }
      }
    }
  }
}
scan(scanDir);
scan(path.join(pkgDir, "gateways"));
rmSync(scanDir, { recursive: true, force: true });
if (hits) {
  console.error(`\n${hits} leak(s) found. Not packing.`);
  process.exit(1);
}
console.log(`  checked ${secrets.size} secret value(s) against ${files} files: none found (${places} path setting(s) not treated as secrets)`);

// 4. The launcher's own tests (they need nothing installed), then pack.
console.log("== Testing the launcher");
run("node", ["--test"], { cwd: pkgDir });

console.log("== Packing");
run("npm", ["pack", "--pack-destination", path.join(root, "packaging")], { cwd: pkgDir });
