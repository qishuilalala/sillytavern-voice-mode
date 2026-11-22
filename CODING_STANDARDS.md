# Coding Standards

Subjective engineering rules for `sillytavern-voice-mode` that complement `tsc` and `eslint`.

## Module Depth & Host Seam

- **Isolate SillyTavern globals in `src/index.ts`**: Only `src/index.ts` imports `"sillytavern/script"`, `"sillytavern/extensions"`, and `"sillytavern/secrets"`. Every runtime module (`src/runtime.ts`, `src/stream-router.ts`, `src/tts-hub.ts`, `src/voice-io.ts`, `src/settings.ts`) receives narrow host capabilities via dependency injection so `node --test` exercises real domain modules without browser shims.
- **Reuse `@voice-mode/core` and `@voice-mode/browser` directly**: Sentence segmentation, Markdown/table cleaning, ASR vocabulary replacement, emotion cue parsing/compilation, secret redaction, bounded-prefetch `PlaybackQueue`, `AecBargeInMonitor`, `FocusTextInjector`, and `DaemonClient` live in vendored `@voice-mode/*` packages (`>= 75%` bundle share enforced by `scripts/check-release-gate.mjs`). Fix or extend upstream packages rather than copying logic locally.
- **Call `getContext()` per event**: SillyTavern's `getContext()` returns a point-in-time snapshot (`chat`, `characterId`, `groupId`, `streamingProcessor`). Resolve it inside each handler instead of caching across turns.

## Streaming & Barge-In Invariants

- **Cumulative-to-delta `STREAM_TOKEN_RECEIVED`**: SillyTavern passes the cumulative reply text accumulated so far on every streaming tick. Always slice incremental deltas (`cumulative.slice(prev.length)` with common-prefix fallback) and reset state on `GENERATION_STARTED`, `GENERATION_STOPPED`, `CHAT_CHANGED`, `MESSAGE_SWIPED`, and `MESSAGE_DELETED`.
- **Guard `stopGeneration()` with `isGenerating()`**: SillyTavern's internal `abortController` remains truthy when idle. Always check `isGenerating()` (or active `streamingProcessor`) before calling `stopGeneration()` on Voice Barge-In so local-only TTS cancellation never emits spurious `GENERATION_STOPPED` events.
- **Honest AEC3 policy**: Browser `window.speechSynthesis` bypasses Chromium's WebAudio AEC3 reference mixer. Hands-free microphone barge-in arms only when audio plays through `HTMLAudioElement` on a verified `Secure Origin` (`window.isSecureContext === true`); otherwise fall back cleanly to manual button/hotkey interruption.

## Security & Git-Install Hygiene

- **Zero secrets in `extension_settings`**: Store API keys and daemon bearer tokens exclusively through SillyTavern's `/api/secrets/write` (`writeSecret`) plus ephemeral tab memory (`SillyTavernSecretBroker`). `ensureExtensionSettings` allowlists persisted fields and strips secret-shaped strings before `saveSettingsDebounced()`.
- **Safe DOM construction**: Build extension drawer elements with `document.createElement` and `textContent` rather than interpolating character names or error messages into `innerHTML`. Pass error strings through `formatSafeError` (`redactSecrets`) before display.
- **Keep Git-install artifacts fresh**: SillyTavern's one-click Git installer clones this repository without running `pnpm install` or `pnpm run build`. Commit `manifest.json`, `style.css`, and `dist/index.js` together whenever `src/**` or `vendor/*.tgz` changes.
