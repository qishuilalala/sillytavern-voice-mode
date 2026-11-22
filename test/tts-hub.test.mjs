import assert from "node:assert/strict";
import test from "node:test";

import { encodeMonoPcm16Wav } from "@voice-mode/core";
import { ensureExtensionSettings } from "../src/settings.ts";
import {
  BrowserAudioSink,
  SYSTEM_TTS_MIME,
  VoiceModeTtsHub,
} from "../src/tts-hub.ts";

function makeSineWavBytes(durationMs = 80, sampleRate = 16000) {
  const count = Math.floor((sampleRate * durationMs) / 1000);
  const pcm = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pcm[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return encodeMonoPcm16Wav(pcm, sampleRate);
}

test("VoiceModeTtsHub resolves character vs narrator voices across voiceMap, compiles emotion tags, and serializes playback", async () => {
  const store = {
    voice_mode: {
      enabled: true,
      narrationSplitEnabled: true,
      defaultVoice: { engine: "system", voice: "DefaultSys" },
      narratorVoice: { engine: "system", voice: "NarratorSys" },
      voiceMap: {
        "seraphina.png": { engine: "openai-compat", voice: "shimmer" },
      },
    },
  };
  const settings = ensureExtensionSettings(store);

  const openaiRequests = [];
  const playedEvents = [];
  const wavBytes = makeSineWavBytes(40);

  const hub = new VoiceModeTtsHub({
    getSettings: () => settings,
    getSecret: async (slot) => (slot === "openaiTts" ? "sk-test-1234567890abcdef" : null),
    fetchImpl: async function strictFetch(url, init) {
      if (this && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      openaiRequests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(wavBytes, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    },
    sink: {
      async play(payload) {
        playedEvents.push({ mime: payload.mime, byteLength: payload.audio.byteLength });
      },
    },
    onUtteranceStart: (info) => {
      playedEvents.push({ started: info });
    },
  });

  hub.enqueueUtterance({
    role: "narrator",
    speaker: "Seraphina",
    avatar: "seraphina.png",
    text: "The candle flickered.",
  });
  hub.enqueueUtterance({
    role: "character",
    speaker: "Seraphina",
    avatar: "seraphina.png",
    text: "<whisper>Come closer.</whisper> <break 250ms> Don't be afraid.",
  });

  await hub.waitUntilDrained();

  const starts = playedEvents.filter((e) => e.started).map((e) => e.started);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].role, "narrator");
  assert.equal(starts[0].engine, "system");
  assert.equal(starts[0].voice, "NarratorSys");

  assert.equal(starts[1].role, "character");
  assert.equal(starts[1].engine, "openai-compat");
  assert.equal(starts[1].voice, "shimmer");
  assert.doesNotMatch(starts[1].plainText, /<whisper>|<break/);

  assert.equal(openaiRequests.length, 1);
  assert.equal(openaiRequests[0].body.voice, "shimmer");
  assert.doesNotMatch(openaiRequests[0].body.input, /<whisper>|<break/);
  assert.equal(playedEvents.filter((e) => e.mime === SYSTEM_TTS_MIME).length, 1);
  assert.equal(playedEvents.filter((e) => e.mime === "audio/wav").length, 1);

  await hub.dispose();
});

test("VoiceModeTtsHub falls back from offline kokoro-daemon to system TTS in < 1s", async () => {
  const store = {
    voice_mode: {
      enabled: true,
      defaultVoice: { engine: "kokoro-daemon", voice: "zf_001" },
      daemonBaseUrl: "http://127.0.0.1:18790",
    },
  };
  const settings = ensureExtensionSettings(store);
  const fallbacks = [];
  const sinks = [];

  const hub = new VoiceModeTtsHub({
    getSettings: () => settings,
    getSecret: async () => null,
    fetchImpl: async () => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:18790");
    },
    onDaemonFallback: (reason) => fallbacks.push(reason),
    sink: {
      async play(payload) {
        sinks.push(payload.mime);
      },
    },
  });

  const t0 = performance.now();
  hub.enqueueUtterance({
    role: "character",
    speaker: "Alice",
    text: "Daemon is offline, fallback must happen fast.",
  });
  await hub.waitUntilDrained();
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 1000, `Expected < 1000ms daemon fallback, got ${elapsedMs.toFixed(1)}ms`);
  assert.equal(fallbacks.length, 1);
  assert.deepEqual(sinks, [SYSTEM_TTS_MIME]);

  await hub.dispose();
});

test("VoiceModeTtsHub forwards raw emotion tags to kokoro-daemon, executes mid-sentence breaks on system TTS, falls back to direct BYOK when server plugin is 404, and reuses one HTMLAudioElement", async () => {
  const wavBytes = makeSineWavBytes(30);

  // 1. Daemon receives raw <whisper> & <break> tags unstripped
  const daemonBodies = [];
  const daemonSettings = ensureExtensionSettings({
    voice_mode: {
      enabled: true,
      defaultVoice: { engine: "kokoro-daemon", voice: "zf_001" },
      daemonBaseUrl: "http://127.0.0.1:18790",
    },
  });
  const daemonHub = new VoiceModeTtsHub({
    getSettings: () => daemonSettings,
    getSecret: async () => null,
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v1/health")) {
        return new Response(
          JSON.stringify({ ok: true, service: "voice-daemon", version: "0.1.0", capabilities: ["tts"], voices: ["zf_001"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      daemonBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(wavBytes, { status: 200, headers: { "content-type": "audio/wav" } });
    },
    sink: { async play() {} },
  });

  daemonHub.enqueueUtterance({
    role: "character",
    speaker: "Alice",
    text: "<whisper>Secret plan.</whisper> <break 250ms> Move now.",
  });
  await daemonHub.waitUntilDrained();
  assert.equal(daemonBodies.length, 1);
  assert.match(daemonBodies[0].input, /<whisper>Secret plan\.<\/whisper>/);
  assert.match(daemonBodies[0].input, /<break 250ms>/);
  await daemonHub.dispose();

  // 2. System TTS payload preserves per-segment mid-sentence breakAfterMs and whisper flags
  let capturedSystemPayload = null;
  const sysSettings = ensureExtensionSettings({
    voice_mode: { enabled: true, defaultVoice: { engine: "system", voice: "" } },
  });
  const sysHub = new VoiceModeTtsHub({
    getSettings: () => sysSettings,
    getSecret: async () => null,
    sink: {
      async play(payload) {
        capturedSystemPayload = JSON.parse(new TextDecoder().decode(payload.audio));
      },
    },
  });
  sysHub.enqueueUtterance({
    role: "character",
    speaker: "Alice",
    text: "Wait here <break 120ms> <whisper>stay low</whisper>",
  });
  await sysHub.waitUntilDrained();
  assert.ok(Array.isArray(capturedSystemPayload?.segments));
  assert.equal(capturedSystemPayload.segments.length, 2);
  assert.equal(capturedSystemPayload.segments[0].text, "Wait here");
  assert.equal(capturedSystemPayload.segments[0].breakAfterMs, 120);
  assert.equal(capturedSystemPayload.segments[1].text, "stay low");
  assert.equal(capturedSystemPayload.segments[1].whisper, true);
  await sysHub.dispose();

  // 3. useServerPluginProxy: true with 404 /api/plugins/voice-mode/health falls back to direct OpenAI TTS (not system!)
  const proxyCalls = [];
  const playedMimes = [];
  const proxySettings = ensureExtensionSettings({
    voice_mode: {
      enabled: true,
      useServerPluginProxy: true,
      openaiTtsPresetId: "custom",
      openaiTtsBaseUrl: "http://127.0.0.1:18199/v1",
      defaultVoice: { engine: "openai-compat", voice: "alloy", presetId: "custom" },
    },
  });
  const proxyHub = new VoiceModeTtsHub({
    getSettings: () => proxySettings,
    getSecret: async () => null,
    fetchImpl: async (url) => {
      const u = String(url);
      proxyCalls.push(u);
      if (u === "/api/plugins/voice-mode/health") {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(wavBytes, { status: 200, headers: { "content-type": "audio/wav" } });
    },
    sink: {
      async play(payload) {
        playedMimes.push(payload.mime);
      },
    },
  });
  proxyHub.enqueueUtterance({ role: "character", speaker: "Bob", text: "Direct fallback works." });
  await proxyHub.waitUntilDrained();
  assert.ok(proxyCalls.includes("/api/plugins/voice-mode/health"));
  assert.ok(proxyCalls.includes("http://127.0.0.1:18199/v1/audio/speech"));
  assert.deepEqual(playedMimes, ["audio/wav"]);
  await proxyHub.dispose();

  // 4. BrowserAudioSink reuses a single persistent HTMLAudioElement across sentences
  let audioCtorCount = 0;
  const prevAudio = globalThis.Audio;
  class FakeAudioElement {
    constructor(src = "") {
      audioCtorCount++;
      this.src = src;
      this.onended = null;
      this.onerror = null;
    }
    pause() {}
    removeAttribute(attr) {
      if (attr === "src") this.src = "";
    }
    load() {}
    async play() {
      queueMicrotask(() => this.onended?.());
    }
  }
  globalThis.Audio = FakeAudioElement;
  try {
    const sink = new BrowserAudioSink();
    const ac = new AbortController();
    await sink.play({ audio: wavBytes, mime: "audio/wav" }, ac.signal);
    await sink.play({ audio: wavBytes, mime: "audio/wav" }, ac.signal);
    await sink.play({ audio: wavBytes, mime: "audio/wav" }, ac.signal);
    assert.equal(audioCtorCount, 1, "Must reuse one persistent HTMLAudioElement for AEC3 convergence");
    sink.stop();
  } finally {
    globalThis.Audio = prevAudio;
  }
});
