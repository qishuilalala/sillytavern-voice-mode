#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

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
fs.copyFileSync(srcFile, destFile);

console.log(`Installed optional server plugin to ${destFile}`);
console.log("Remember to set 'enableServerPlugins: true' in SillyTavern config.yaml and restart the server.");
