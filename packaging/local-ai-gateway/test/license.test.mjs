// node --test packaging/local-ai-gateway/test
// What the package says about its license has to agree with itself, because it is published and can't be changed
// afterwards: the id in package.json, the LICENSE file that ships, and the notices file the build makes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("package.json"));

test("package.json declares the MIT license, and the LICENSE file that ships is the MIT text", () => {
  assert.equal(manifest.license, "MIT");
  const text = read("LICENSE");
  assert.match(text, /^MIT License\n/);
  assert.match(text, /^Copyright \(c\) 20\d\d \S.+$/m, "a copyright line with a year and a name");
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test("the files npm packs include the license and the third-party notices", () => {
  assert.ok(manifest.files.includes("LICENSE"));
  assert.ok(manifest.files.includes("THIRD_PARTY_NOTICES.md"), "the build makes it; without this line npm would leave it out");
});

test("the README names the license it is published under", () => {
  assert.match(read("README.md"), /\[MIT\]\(LICENSE\)/);
});
