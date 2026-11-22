# Changelog

All notable changes to `sillytavern-voice-mode` are documented in this file.

## [0.1.0] - 2026-11-22

### Added

- **Streaming First-Sentence TTS (`STREAM_TOKEN_RECEIVED`)**: Cumulative-to-delta token slicer backed by `@voice-mode/core` `SentenceSegmenter` with `GENERATION_ENDED` tail flush and non-streaming `CHARACTER_MESSAGE_RENDERED` fallback.
- **Multi-Character Voice Map & Narration Split**: Solo and group chat speaker routing (`avatar` / `name` / card `extensions.voice_mode` / `defaultVoice`) plus `*narration*` vs dialogue role separation preserving `**bold**` Markdown.
- **Multi-Engine TTS Hub**: Zero-config browser `system` TTS, local `kokoro-daemon` (`DaemonClient`, 103 Kokoro voices with `< 1s` offline fallback), `OpenAiCompatTtsEngine`, and `MimoTtsEngine` serialized through `@voice-mode/browser` `PlaybackQueue`.
- **AEC3 Hands-Free Voice Barge-In + `stopGeneration()`**: `@voice-mode/browser` `AecBargeInMonitor` + energy/ZCR VAD worker with `isGenerating()`-guarded LLM abort and `Alt+Shift+B` manual fallback.
- **Voice Dictation into `#send_textarea`**: Browser `SpeechRecognition`, local `voice-daemon`, and OpenAI-compatible Whisper ASR with `createAsrReplacer` vocabulary rules, `FocusTextInjector` insertion, and optional `#send_but` auto-send (`Alt+Shift+V`).
- **Emotion Cue DSL (`ADR-0007`)**: Optional `setExtensionPrompt` injection (`buildEmotionPromptInstruction`) and `compileEmotionPlan` prosody handling for `<whisper>...</whisper>` and `<break Nms>`.
- **Security & Host Hardening**: `SillyTavernSecretBroker` (`/api/secrets/write` + ephemeral session cache; zero secrets in `extension_settings`), `window.isSecureContext` LAN remediation banner, and optional SSRF-hardened `server-plugin/index.mjs` + `scripts/install-server-plugin.mjs`.
