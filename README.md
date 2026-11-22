# Voice Mode

[简体中文](./README.zh-CN.md) · [Security Policy](./SECURITY.md) · [Glossary](./GLOSSARY.md) · [Changelog](./CHANGELOG.md)

Local-first streaming TTS, hands-free AEC3 Voice Barge-In, multi-character Voice Map routing, and Emotion Cue prosody for [SillyTavern](https://github.com/SillyTavern/SillyTavern) (`>= 1.19.1`).

## Highlights

- **Mid-Stream First-Sentence Playback**: Converts SillyTavern's cumulative `STREAM_TOKEN_RECEIVED` stream into incremental deltas and feeds `@voice-mode/core`'s `SentenceSegmenter` so the first sentence speaks while tokens are still generating (`GENERATION_ENDED` flushes the tail; `CHARACTER_MESSAGE_RENDERED` covers non-streaming backends).
- **Multi-Character Voice Map & `*Narration*` Split**: Assign distinct voices per character name or avatar across solo and group chats, with automatic separation between `*narration*` spans and spoken `"dialogue"` (without misclassifying `**bold**` Markdown).
- **Four TTS Backends with `< 1s` Offline Fallback**:
  - `system` — Zero-config browser `window.speechSynthesis` default.
  - `kokoro-daemon` — Optional local `voice-daemon` (`http://127.0.0.1:18790`, 103 Kokoro multilingual voices) with `< 1s` automatic fallback to `system` when the daemon is offline.
  - `openai-compat` & `mimo` — BYOK cloud or self-hosted HTTP TTS engines (`@voice-mode/core`).
- **Hands-Free AEC3 Voice Barge-In + `stopGeneration()`**: Monitors 16 kHz microphone input via `@voice-mode/browser`'s `AecBargeInMonitor` during `HTMLAudioElement` playback (`autoGainControl: false`, verified native AEC3) and immediately cancels queued speech **and** aborts active LLM generation (`if (isGenerating()) stopGeneration()`). Includes manual button and `Alt+Shift+B` hotkey fallback.
- **Voice Dictation into `#send_textarea`**: Supports browser `SpeechRecognition`, local `voice-daemon` ASR (`Zipformer2` / `SenseVoice`), and OpenAI-compatible Whisper ASR with `@voice-mode/core` vocabulary replacements (`createAsrReplacer`), injecting into `#send_textarea` via `FocusTextInjector` (`Alt+Shift+V`) with optional hands-free auto-send (`#send_but`).
- **Emotion Cue DSL (`<whisper>`, `<break Nms>`)**: Optional system-prompt toggle (`setExtensionPrompt`) guiding character replies to emit natural prosody tags compiled by `compileEmotionPlan` without speaking tags aloud.
- **Server-Side Secrets & Secure Origin Guard**: API keys are stored via SillyTavern's `/api/secrets/write` (`secrets.json`) + ephemeral tab memory—never in `extension_settings`. Non-secure LAN HTTP origins (`!window.isSecureContext`) display actionable loopback/SSH/HTTPS guidance before microphone access.

## One-Click Installation in SillyTavern

1. Open SillyTavern (`>= 1.19.1`) → **Extensions** → **Install extension**.
2. Paste the repository URL:
   ```text
   https://github.com/qishuilalala/sillytavern-voice-mode
   ```
3. Click **Install just for me** (or **Install for all users**). No Extras API server or `enableServerPlugins` change is required.

Because SillyTavern clones UI extensions directly without running a build step, `manifest.json`, `style.css`, and the self-contained ES module bundle `dist/index.js` are committed and verified fresh in CI.

## Optional Server Plugin (CORS Proxy)

Pure UI extension mode works out of the box with `enableServerPlugins: false`. Users calling custom BYOK TTS endpoints that lack browser CORS headers can optionally install the companion server plugin:

```bash
node scripts/install-server-plugin.mjs /path/to/SillyTavern
# Set enableServerPlugins: true in SillyTavern config.yaml and restart SillyTavern.
```

## Microphone Access on Remote / LAN Hosts (`window.isSecureContext`)

Browsers restrict `navigator.mediaDevices.getUserMedia` to Secure Origins:
- Local loopback (`http://127.0.0.1:8000` or `http://localhost:8000`) works without TLS.
- For LAN, Termux, or remote servers, forward the port over SSH (`ssh -L 8000:127.0.0.1:8000 user@host`) or enable HTTPS (`ssl.enabled: true` in SillyTavern `config.yaml`, Caddy/Nginx TLS, or Tailscale HTTPS).

## Keyboard Shortcuts

- `Alt+Shift+B` — Immediate Voice Barge-In (stops TTS playback and aborts active LLM generation).
- `Alt+Shift+V` — Start / stop microphone voice dictation into `#send_textarea`.

## Development

```bash
pnpm install
pnpm run check:all
pnpm audit --audit-level high
```

## License

[MIT](./LICENSE)
