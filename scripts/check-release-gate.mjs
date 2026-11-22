import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.version, pkg.version, "manifest.json version must match package.json version");
assert.equal(manifest.display_name, "Voice Mode", "manifest.json display_name must be 'Voice Mode'");
assert.equal(manifest.js, "dist/index.js", "manifest.json js must point to dist/index.js");
assert.equal(manifest.css, "style.css", "manifest.json css must point to style.css");
assert.deepEqual(manifest.requires, [], "manifest.json requires must be empty for zero-Extras loading");

for (const rel of ["manifest.json", "style.css", "dist/index.js", "LICENSE", "SECURITY.md", "GLOSSARY.md"]) {
  assert.ok(fs.existsSync(path.join(root, rel)), `Missing required SillyTavern Git-install file: ${rel}`);
}

const bundle = fs.readFileSync(path.join(root, "dist/index.js"), "utf8");
assert.match(bundle, /\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/script\.js/, "dist/index.js must resolve ../../../../../script.js");
assert.match(bundle, /\.\.\/\.\.\/\.\.\/\.\.\/extensions\.js/, "dist/index.js must resolve ../../../../extensions.js");
assert.doesNotMatch(bundle, /\bnode:/, "dist/index.js must not contain node:* imports");

try {
  execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
  const diff = execFileSync("git", ["status", "--porcelain", "--", "dist/index.js", "manifest.json", "style.css"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(
    diff,
    "",
    `Committed SillyTavern Git-install artifacts are out of date:\n${diff}`,
  );
} catch (err) {
  if (err instanceof assert.AssertionError) {
    throw err;
  }
  // No initial commit yet; skip git status comparison until committed.
}

console.log(`Release gate OK: ${manifest.display_name} v${manifest.version} (${manifest.js}, ${manifest.css})`);
