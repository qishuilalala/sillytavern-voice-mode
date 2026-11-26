#!/usr/bin/env node
// i18n 完整性检查：src 中 text("key", "fallback") 的 key 与 locales/zh-cn.json 比对。
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const locale = JSON.parse(fs.readFileSync(path.join(root, 'locales/zh-cn.json'), 'utf8'))
const localeKeys = new Set(Object.keys(locale).map((key) => key.replace(/^voice_mode\./, '')))

const used = new Map() // key -> files
const dynamicPrefixes = new Set()
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.(ts|mjs)$/.test(entry.name)) {
      const text = fs.readFileSync(p, 'utf8')
      for (const m of text.matchAll(/\btext\(\s*`([a-z0-9_]+)\$\{/g)) {
        dynamicPrefixes.add(m[1])
      }
      for (const m of text.matchAll(/\b(?:text|t)\(\s*"([a-z0-9_]+)"\s*,/g)) {
        const key = m[1]
        if (!used.has(key)) used.set(key, new Set())
        used.get(key).add(path.relative(root, p))
      }
    }
  }
}
walk(path.join(root, 'src'))

const knownDynamic = new Set(['character', 'narrator']) // text(role, role) / settings labels
const isDynamic = (key) =>
  knownDynamic.has(key) || [...dynamicPrefixes].some((prefix) => key.startsWith(prefix))
const missing = [...used.keys()].filter((key) => !localeKeys.has(key))
const unused = [...localeKeys].filter((key) => !used.has(key) && !isDynamic(key))

console.log(JSON.stringify({
  schema: 'voice-mode/i18n-check@1',
  used: used.size,
  dynamicPrefixes: [...dynamicPrefixes],
  translated: localeKeys.size,
  missing,
  unused,
}, null, 2))
if (missing.length > 0) process.exit(1)
