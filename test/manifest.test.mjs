import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("SillyTavern Git-install manifest and bundle contract", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.license, "MIT");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.js, "dist/index.js");
  assert.equal(manifest.css, "style.css");
  assert.equal(manifest.hooks?.activate, "activate");
  assert.ok(fs.existsSync(path.join(root, manifest.css)));
  assert.ok(fs.existsSync(path.join(root, manifest.js)));

  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.doesNotMatch(gitignore, /^dist\/?$/m, "dist/ must stay tracked for SillyTavern one-click Git install");
});
