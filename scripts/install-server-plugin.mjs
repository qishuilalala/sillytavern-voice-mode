#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const stRoot = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!stRoot) {
  console.error("Usage: node scripts/install-server-plugin.mjs <path-to-SillyTavern-root>");
  process.exit(1);
}

const pluginsDir = path.join(stRoot, "plugins");
if (!fs.existsSync(pluginsDir)) {
  console.error(`SillyTavern plugins directory not found: ${pluginsDir}`);
  process.exit(1);
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const srcFile = path.join(repoRoot, "server-plugin", "index.mjs");
const destDir = path.join(pluginsDir, "voice-mode");
const destFile = path.join(destDir, "index.mjs");

fs.mkdirSync(destDir, { recursive: true });

// Bundle @voice-mode/core constants & redactor inline so the installed server plugin
// runs inside SillyTavern without requiring @voice-mode/core in SillyTavern's node_modules.
await esbuild.build({
  entryPoints: [srcFile],
  bundle: true,
  outfile: destFile,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["node:*"],
  logLevel: "silent",
});

console.log(`Installed optional server plugin to ${destFile}`);
console.log("Remember to set 'enableServerPlugins: true' in SillyTavern config.yaml and restart the server.");
