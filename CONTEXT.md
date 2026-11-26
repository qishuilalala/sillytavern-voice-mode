# Context

Orientation and module map for `sillytavern-voice-mode` (`0.1.0`), a third-party UI extension bringing streaming speech playback, hands-free AEC3 Voice Barge-In, multi-character Voice Map routing, and Emotion Cue prosody to SillyTavern (`>= 1.19.1`).

## 中文维护入口

- 安装、第一次听写和朗读、语音数据去向及权限恢复见[中文使用指南](./README.zh-CN.md)。调整设置或命令时，核对英、简中界面与两份 README 的步骤。
- 酒馆直接加载 Git 中的 `dist/index.js`。更新界面后重建，在扩展抽屉复核两种语言，并检查相应安装资源已随提交一起更新。
- `vendor/` 固定使用母仓构建的 `core`、`browser` 两份归档。变更共享包时记录兼容的四仓提交，按母仓 [ADR-0005](https://github.com/qishuilalala/obsidian-voice-mode/blob/main/docs/adr/0005-multi-repo-package-sharing-and-daemon-seam.md) 核对全部五份归档。

## Quick Commands

```bash
pnpm install --frozen-lockfile
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
| `src/tts-hub.ts` | Resolves character/narrator `VoiceAssignment`, compiles `<whisper>` / `<break>` plans, drives `@voice-mode/browser` `PlaybackQueue` across `system`, `kokoro-daemon` (`< 1s` offline fallback), `openai-compat`, and `mimo`, and exports recent replies to a single WAV (`exportUtterances`, non-WAV engines report unavailable). |
| `src/voice-io.ts` | Runs `@voice-mode/browser` `AecBargeInMonitor` + `SherpaWorkerClient` energy/ZCR VAD, drives the shared `DuplexProtocol` for barge-in actions, supports the opt-in browser-ASR semantic endpoint, synchronizes `stopGeneration()`, and injects dictated speech into `#send_textarea` via `FocusTextInjector`. |
| `src/settings.ts` | Allowlisted `extension_settings.voice_mode` normalizer (incl. `semanticEndpoint`), `SillyTavernSecretBroker` (`/api/secrets/write` + ephemeral session cache), and `window.isSecureContext` inspector. |
| `server-plugin/index.mjs` | Optional Express server plugin (`/api/plugins/voice-mode/tts`) for users enabling `enableServerPlugins: true` who want server-side CORS + `secrets.json` injection. |
| `vendor/*.tgz` | Pinned `@voice-mode/core@0.1.0` and `@voice-mode/browser@0.1.0` tarballs ensuring deterministic offline/CI installs. |

## Context Pointers

- **Domain terms**: Read [`GLOSSARY.md`](./GLOSSARY.md) before naming types, settings, or tests (`Voice Mode`, `Streaming Utterance`, `Voice Barge-In`, `Voice Map`, `Character Voice`, `Emotion Cue`, `Voice Daemon`, `Secure Origin`).
- **Subjective invariants & SillyTavern traps**: Read [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) when modifying event handlers, `stopGeneration()` guards, relative host imports, or settings persistence.
- **Privacy, LAN HTTPS & SSRF rules**: Read [`SECURITY.md`](./SECURITY.md) before touching network calls, microphone capture, or `server-plugin/index.mjs`.
- **Release & reuse gate**: Run `pnpm run check:release` ([`scripts/check-release-gate.mjs`](./scripts/check-release-gate.mjs)) after any source or manifest edit to verify **`>= 73.3%`** shared core reuse (threshold history: 75.05% → 74% → 73.3%; extract shared code before lowering it) and zero `dist/index.js` drift.
