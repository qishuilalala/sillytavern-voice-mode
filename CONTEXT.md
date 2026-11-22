# Context

Orientation and module map for `sillytavern-voice-mode` (`0.1.0`), a third-party UI extension bringing streaming speech playback, hands-free AEC3 Voice Barge-In, multi-character Voice Map routing, and Emotion Cue prosody to SillyTavern (`>= 1.19.1`).

## Quick Commands

```bash
pnpm install
pnpm run test          # Node >= 22.18 native TypeScript unit suite
pnpm run build         # Bundles src/index.ts + @voice-mode/* -> dist/index.js
pnpm run check:all     # typecheck + lint + test + build + check:release
```

## Architecture & Module Map

SillyTavern serves cloned third-party extensions directly as browser ES modules at `/scripts/extensions/third-party/sillytavern-voice-mode/dist/index.js` without executing package builds. `esbuild.config.mjs` bundles `@voice-mode/core` and `@voice-mode/browser` inline while rewriting `"sillytavern/*"` imports to exact 5-level/4-level host URLs (`../../../../../script.js`, `../../../../extensions.js`, `../../../../secrets.js`).

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Thin SillyTavern entrypoint binding host globals (`eventSource`, `getContext`, `secrets`) into `createVoiceModeRuntime` and exporting `activate()`. |
| `src/runtime.ts` | Orchestrates SillyTavern lifecycle events, `setExtensionPrompt` Emotion Cue injection, `#extensions_settings` UI drawer, and diagnostics. |
| `src/stream-router.ts` | Converts cumulative `STREAM_TOKEN_RECEIVED` strings into incremental deltas, splits `*narration*` vs dialogue spans, and feeds `@voice-mode/core` `SentenceSegmenter`. |
| `src/tts-hub.ts` | Resolves character/narrator `VoiceAssignment`, compiles `<whisper>` / `<break>` plans, and drives `@voice-mode/browser` `PlaybackQueue` across `system`, `kokoro-daemon` (`< 1s` offline fallback), `openai-compat`, and `mimo`. |
| `src/voice-io.ts` | Runs `@voice-mode/browser` `AecBargeInMonitor` + `SherpaWorkerClient` energy/ZCR VAD, synchronizes `stopGeneration()`, and injects dictated speech into `#send_textarea` via `FocusTextInjector`. |
| `src/settings.ts` | Allowlisted `extension_settings.voice_mode` normalizer, `SillyTavernSecretBroker` (`/api/secrets/write` + ephemeral session cache), and `window.isSecureContext` inspector. |
| `server-plugin/index.mjs` | Optional Express server plugin (`/api/plugins/voice-mode/tts`) for users enabling `enableServerPlugins: true` who want server-side CORS + `secrets.json` injection. |
| `vendor/*.tgz` | Pinned `@voice-mode/core@0.1.0` and `@voice-mode/browser@0.1.0` tarballs ensuring deterministic offline/CI installs. |

## Context Pointers

- **Domain terms**: Read [`GLOSSARY.md`](./GLOSSARY.md) before naming types, settings, or tests (`Voice Mode`, `Streaming Utterance`, `Voice Barge-In`, `Voice Map`, `Character Voice`, `Emotion Cue`, `Voice Daemon`, `Secure Origin`).
- **Subjective invariants & SillyTavern traps**: Read [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) when modifying event handlers, `stopGeneration()` guards, relative host imports, or settings persistence.
- **Privacy, LAN HTTPS & SSRF rules**: Read [`SECURITY.md`](./SECURITY.md) before touching network calls, microphone capture, or `server-plugin/index.mjs`.
- **Release & reuse gate**: Run `pnpm run check:release` ([`scripts/check-release-gate.mjs`](./scripts/check-release-gate.mjs)) after any source or manifest edit to verify `>= 75%` shared core reuse and zero `dist/index.js` drift.
