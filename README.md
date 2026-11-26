# Voice Mode

[简体中文](./README.zh-CN.md) · [Security Policy](./SECURITY.md) · [Glossary](./GLOSSARY.md) · [Changelog](./CHANGELOG.md)

Local-first streaming TTS, hands-free AEC3 Voice Barge-In, multi-character Voice Map routing, and Emotion Cue prosody for [SillyTavern](https://github.com/SillyTavern/SillyTavern) (`>= 1.19.1`).

## One-Click Installation in SillyTavern

1. Open SillyTavern (`>= 1.19.1`) → **Extensions** → **Install extension**.
2. Paste the repository URL:
   ```text
   https://github.com/qishuilalala/sillytavern-voice-mode
   ```
3. Click **Install just for me** (or **Install for all users**). No Extras API server or `enableServerPlugins` change is required.

Because SillyTavern clones UI extensions directly without running a build step, `manifest.json`, `style.css`, and the self-contained ES module bundle `dist/index.js` are committed and verified fresh in CI.

## First reply and first dictation

1. In **Extensions → Voice Mode**, enable **Enable Streaming Voice Mode** and choose **Browser System TTS (Zero Config)** under **Default Character Voice**. Open a character chat and send “Say hello in one sentence.” With a streaming model the extension reads completed sentences as they arrive. Other backends can read the rendered reply.
2. Use a local loopback or HTTPS connection. Choose **Browser SpeechRecognition ASR**, click **Dictate Mic** (or press `Alt+Shift+V`), and grant microphone access. Speak a sentence and pause. Check the result in the chat input, then send it. Auto-send is off by default.
3. To interrupt playback and any active generation, use **Stop / Barge-In** or `Alt+Shift+B`. Use manual interruption with browser system speech. Hands-free interruption needs a supported audio engine and working browser echo cancellation.

## Choosing where speech is processed

Browser speech synthesis uses the chosen system voice. Browser dictation may send audio to the browser provider. Choose a local [Voice Mode Daemon](https://github.com/qishuilalala/voice-mode-daemon) for native Kokoro playback or local recognition. Configure its loopback address and token in Voice Mode. If it disconnects, Kokoro playback can use system speech. Daemon dictation can fall back to the configured OpenAI-compatible transcription endpoint.

For cloud speech, select an OpenAI-compatible engine or MiMo for playback, or OpenAI-compatible Whisper for dictation. Check the endpoint and save the matching key with **Save Server Secret**. The speech provider receives speakable text or utterance audio. See the [data flow details](./SECURITY.md).

## Capability tiers

The extension works immediately with zero configuration, but the advertised features deepen with the backend you choose:

| Tier | Setup | What you get | Limits |
| --- | --- | --- | --- |
| **Zero-config** | Install the extension only | Browser system TTS reads replies; browser `SpeechRecognition` dictates into `#send_textarea`; manual barge-in (`Alt+Shift+B`). | System voices only (no per-character timbre variation); emotion tags are stripped before speaking; hands-free AEC3 barge-in stays manual. |
| **Advanced · local daemon** | Run [Voice Mode Daemon](https://github.com/qishuilalala/voice-mode-daemon) from source (developer-only backend) | 103 Kokoro voices, `<whisper>`/`<break Nms>` emotion prosody, local `Zipformer2`/`SenseVoice` dictation, hands-free AEC3 barge-in. | Requires Node.js + pnpm build + model download; the daemon is not distributed as a store package. |
| **Advanced · BYOK cloud** | Configure an OpenAI-compatible or MiMo endpoint and save the key | Cloud TTS/ASR quality without local model downloads. | Needs an API key; speakable text or utterance audio leaves the machine to the chosen provider. |

Emotion tags are only audible on engines that support them; on the `system` engine they are stripped from the speech rather than read aloud.

### Engine expression capabilities

Capabilities come from `@voice-mode/core`'s expression contract; unsupported facets are disclosed instead of being silently dropped.

| Engine | Voices | Rate | Pause | Whisper | Emotion |
| --- | --- | --- | --- | --- | --- |
| `system` | host-provided | Yes | Simulated by segment splitting | Stripped | Stripped |
| `kokoro-daemon` | 103 | Yes | Native `<break Nms>` (≤5000 ms) | Native (×0.5 gain) | — |
| `openai-compat` | provider-dependent | Yes | provider-dependent | provider-dependent | Instructions (provider-dependent) |
| `mimo` | 9 | Yes | provider-dependent | provider-dependent | Instructions |

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

If the browser denies microphone permission, allow the site to use the microphone in the address bar and check your operating system’s microphone permission. If browser recognition is unavailable, select the local daemon or your configured Whisper endpoint. For silent playback, check that streaming voice is enabled, the tab is audible, and the selected voice is available.

## Keyboard Shortcuts

- `Alt+Shift+B` — Immediate Voice Barge-In (stops TTS playback and aborts active LLM generation).
- `Alt+Shift+V` — Start / stop microphone voice dictation into `#send_textarea`.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run check:all
pnpm audit --audit-level high
```

## License

[MIT](./LICENSE)
