// Writes THIRD_PARTY_NOTICES.md for the `npx local-ai-gateway` package (called by build-package.mjs): the licenses of the
// third-party code the package ships. MIT, ISC and Apache-2.0 each ask for their notice to travel with the code, and the
// console's build copies the code without its license files, so they are gathered here from the installed packages.
//
// What the package ships of other people's work:
//   * the packages inside the console archive's node_modules (the build's standalone output, `standalone` below);
//   * the root dependencies compiled into the console's own files (COMPILED_IN), which have no folder of their own;
//   * the Geist fonts that next/font/google puts in the console's static files (packaging/third-party/Geist-OFL.txt).
// The Python packages the gateways need (fastapi, uvicorn, psutil, playwright ...) are not in the package: the launcher
// installs them from PyPI on the user's computer, with their own licenses.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Root dependencies whose code is compiled into the console's own files.
const COMPILED_IN = ["undici"];
// Root dependencies that the local edition never loads, so none of their code is in the package.
const NOT_SHIPPED = ["@supabase/supabase-js"];

function licenseFile(dir) {
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return names.find((name) => /^(licen[cs]e|copying)(\.[a-z]+)?$/i.test(name)) ?? null;
}

function shippedPackages(modules) {
  const found = [];
  for (const name of readdirSync(modules)) {
    if (name.startsWith(".")) continue;
    const scope = name.startsWith("@") ? readdirSync(path.join(modules, name)).map((n) => `${name}/${n}`) : [name];
    for (const pkg of scope) if (existsSync(path.join(modules, pkg, "package.json"))) found.push(pkg);
  }
  return found;
}

export function writeThirdPartyNotices({ root, standalone, out }) {
  const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const shipped = shippedPackages(path.join(standalone, "node_modules"));

  // Whoever adds a dependency has to say whether it ships, or its license could be missing from the package.
  const known = new Set([...shipped, ...COMPILED_IN, ...NOT_SHIPPED]);
  const unknown = Object.keys(rootPackage.dependencies ?? {}).filter((name) => !known.has(name));
  if (unknown.length) {
    throw new Error(`${unknown.join(", ")}: a root dependency that isn't in the console archive, COMPILED_IN or NOT_SHIPPED (scripts/third-party-notices.mjs). Say which it is.`);
  }
  for (const name of NOT_SHIPPED) if (shipped.includes(name)) throw new Error(`${name} is in the console archive, but listed as NOT_SHIPPED.`);

  const nextLicense = readFileSync(path.join(root, "node_modules", "next", licenseFile(path.join(root, "node_modules", "next"))), "utf8").trim();
  const sections = [];
  const problems = [];
  for (const name of [...new Set([...shipped, ...COMPILED_IN])].sort()) {
    const dir = path.join(root, "node_modules", name);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const spdx = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "unknown");
    const file = licenseFile(dir);
    let text;
    if (file) text = readFileSync(path.join(dir, file), "utf8").trim();
    else if (name.startsWith("@next/")) text = `Part of Next.js, under its license:\n\n${nextLicense}`;
    else {
      text = `This package ships no license file, so no copyright line is available here. Its package.json says it is ${spdx}.`;
      problems.push(`${name}: no license file`);
    }
    const url = (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    sections.push(`## ${name} ${pkg.version}\n\nLicense: ${spdx}${url ? `\nSource: ${url}` : ""}\n\n~~~~\n${text}\n~~~~\n`);
  }

  // The fonts the console's pages are set in: next/font/google downloads them at build time into the static files.
  const media = path.join(standalone, ".next-local", "static", "media");
  const fonts = existsSync(media) && readdirSync(media).some((f) => f.endsWith(".woff2"));
  if (fonts) {
    const ofl = readFileSync(path.join(root, "packaging", "third-party", "Geist-OFL.txt"), "utf8").trim();
    sections.push(`## Geist and Geist Mono (fonts)\n\nLicense: OFL-1.1\nSource: https://github.com/vercel/geist-font\n\nThe console's pages are set in these fonts, which are in the console's static files (.next-local/static/media, as .woff2).\n\n~~~~\n${ofl}\n~~~~\n`);
  }

  const header = `# Third-party notices

Local AI Gateway is released under the MIT License (see LICENSE). This package also contains the third-party software
below, each under its own license, which is reproduced here as that license asks.

The Python packages the gateways need (fastapi, uvicorn, pydantic-settings, psutil, playwright) are not part of this
package: they are installed from PyPI on your computer the first time it runs, and come with their own licenses.

`;
  writeFileSync(out, `${header}${sections.join("\n")}`);
  return { packages: sections.length - (fonts ? 1 : 0), fonts, problems };
}
