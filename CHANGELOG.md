# Changelog

All notable changes to `sillytavern-voice-mode` are documented in this file.

## [0.1.0] - 2026-11-22

### Fixed

- Group chats now resolve the speaking member from the generated message (`name` / `original_avatar`), so Voice Map matches the character instead of falling back to the group name.
- Interrupting playback no longer re-plays the truncated message: one `CHARACTER_MESSAGE_RENDERED` after a stop is suppressed.
- API keys saved server-side become readable again after a page reload: an indeterminate `canViewSecrets` probe is retried instead of being cached as "cannot view".

### Changed

- `auto_update` is disabled so a pushed commit cannot silently change behaviour for installed users; updates are manual and documented in the README.
- The daemon-offline fallback notice now says the voice may change.


- The extension settings and microphone status follow SillyTavern’s interface language, including Simplified Chinese. With the browser recognizer on automatic language selection, dictation uses the browser’s normal language selection. The microphone returns to idle after a permission error and keeps the recovery instructions visible.

### Added

- **Expression capability disclosure (E1)**: README lists per-engine expression support (voices/rate/pause/whisper/emotion) from `@voice-mode/core`'s capability contract.
- **Scoped expression tags (E2)**: `<slow>`, `<fast>`, `<spell>`, `<volume N>`, `<pitch N>` and `<emotion:NAME>` are parsed and forwarded to instruction-capable engines.
- **Streaming First-Sentence TTS (`STREAM_TOKEN_RECEIVED`)**: Cumulative-to-delta token slicer backed by `@voice-mode/core` `SentenceSegmenter` with `GENERATION_ENDED` tail flush and non-streaming `CHARACTER_MESSAGE_RENDERED` fallback.
- **WAV export**: the settings drawer can export the last character reply or the last 10 replies as a single WAV via any WAV-capable engine (local `kokoro-daemon` or a self-hosted WAV engine); system/MP3 engines report that export is unavailable, and a shared export slot prevents concurrent exports.
- **Copy diagnostics**: a redacted runtime snapshot (activation, first-sentence latency, barge-in count, daemon fallback reason, last error, last 10 utterances) can be copied for bug reports.
- **Opt-in semantic endpoint**: the browser recognizer can route final results through a configurable semantic endpoint (default off; `interimResults` only enabled while the switch is on).
- **Shared duplex interaction state machine**: barge-in actions follow `@voice-mode/browser` `duplex-protocol` (idle/listening/speaking/overlap/barge-in) with duck/stop-playback/cancel-generation/flush-queue actions.
- **Multi-Character Voice Map & Narration Split**: Solo and group chat speaker routing (`avatar` / `name` / card `extensions.voice_mode` / `defaultVoice`) plus `*narration*` vs dialogue role separation preserving `**bold**` Markdown.
- **Multi-Engine TTS Hub**: Zero-config browser `system` TTS, local `kokoro-daemon` (`DaemonClient`, 103 Kokoro voices with `< 1s` offline fallback), `OpenAiCompatTtsEngine`, and `MimoTtsEngine` serialized through `@voice-mode/browser` `PlaybackQueue`.
- **AEC3 Hands-Free Voice Barge-In + `stopGeneration()`**: `@voice-mode/browser` `AecBargeInMonitor` + energy/ZCR VAD worker with `isGenerating()`-guarded LLM abort and `Alt+Shift+B` manual fallback.
- **Voice Dictation into `#send_textarea`**: Browser `SpeechRecognition`, local `voice-daemon`, and OpenAI-compatible Whisper ASR with `createAsrReplacer` vocabulary rules, `FocusTextInjector` insertion, and optional `#send_but` auto-send (`Alt+Shift+V`).
- **Emotion Cue DSL (`ADR-0007`)**: Optional `setExtensionPrompt` injection (`buildEmotionPromptInstruction`) and `compileEmotionPlan` prosody handling for `<whisper>...</whisper>` and `<break Nms>`.
- **Security & Host Hardening**: `SillyTavernSecretBroker` (`/api/secrets/write` + ephemeral session cache; zero secrets in `extension_settings`), `window.isSecureContext` LAN remediation banner, and optional SSRF-hardened `server-plugin/index.mjs` + `scripts/install-server-plugin.mjs`.
