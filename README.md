# Voice Mode

Local-first streaming TTS, hands-free AEC3 voice barge-in, multi-character voice map, and emotion-aware voice mode for [SillyTavern](https://github.com/SillyTavern/SillyTavern) (`>= 1.19.1`).

## One-Click Installation in SillyTavern

1. Open SillyTavern → **Extensions** (`#extensions_settings`) → **Install extension**.
2. Paste the Git repository URL:
   ```text
   https://github.com/qishuilalala/sillytavern-voice-mode
   ```
3. Click **Install just for me** (or **Install for all users**).

Because SillyTavern clones extension repositories directly without running a build step, `manifest.json`, `style.css`, and the self-contained ES module bundle `dist/index.js` are tracked in Git and verified fresh in CI on every commit.

## Development

```bash
pnpm install
pnpm run build
pnpm run check:all
```

## License

[MIT](./LICENSE)
