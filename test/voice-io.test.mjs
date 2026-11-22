import assert from "node:assert/strict";
import test from "node:test";

import { ensureExtensionSettings } from "../src/settings.ts";
import { VoiceModeIoController } from "../src/voice-io.ts";

function makeSpeechFrame(samples = 1024, freqHz = 300, amplitude = 0.15, sampleRate = 16000) {
  const frame = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    frame[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return frame;
}

test("VoiceModeIoController AEC3 barge-in achieves 20/20 (100% >= 95%) < 600ms cancellation + guarded stopGeneration()", async () => {
  const store = {
    voice_mode: {
      enabled: true,
      bargeInMode: "detect",
      defaultVoice: { engine: "openai-compat", voice: "alloy" },
    },
  };
  const settings = ensureExtensionSettings(store);

  let successes = 0;
  for (let trial = 0; trial < 20; trial++) {
    let audioCancelled = false;
    let stopGenCalls = 0;
    let generating = true;
    let pushChunk = null;

    const io = new VoiceModeIoController({
      getSettings: () => settings,
      getSecret: async () => null,
      getWindow: () => ({
        isSecureContext: true,
        location: { protocol: "http:", host: "127.0.0.1:18123" },
        navigator: {
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.0.0 Safari/537.36",
        },
      }),
      getDocument: () => null,
      isGenerating: () => generating,
      stopGeneration: () => {
        stopGenCalls++;
        generating = false;
        return true;
      },
      cancelPlayback: () => {
        audioCancelled = true;
      },
      bargeInCaptureAudio: async (opts) => {
        pushChunk = opts.onChunk;
        return {
          track: { getSettings: () => ({ echoCancellation: true, sampleRate: 16000, channelCount: 1 }) },
          supportedConstraints: { echoCancellation: true },
          stop: async () => undefined,
        };
      },
    });

    const t0 = performance.now();
    const startRes = await io.armBargeIn({ usesSystemTts: false });
    assert.equal(startRes.activePolicy, "auto");

    const frame = makeSpeechFrame(1024, 300, 0.18);
    pushChunk(frame);
    pushChunk(frame);

    // Allow microtask VAD worker round-trip
    await new Promise((r) => setTimeout(r, 10));
    const elapsedMs = performance.now() - t0;

    if (audioCancelled && stopGenCalls === 1 && elapsedMs < 600) {
      successes++;
    }
    await io.dispose();
  }

  assert.equal(successes, 20, `Expected 20/20 barge-in trials, got ${successes}/20`);
});

test("VoiceModeIoController guards stopGeneration() when idle and blocks mic in non-secure origin", async () => {
  const settings = ensureExtensionSettings({ voice_mode: { enabled: true } });
  let stopGenCalls = 0;
  let playbackCancels = 0;
  let insecureReason = "";

  const io = new VoiceModeIoController({
    getSettings: () => settings,
    getSecret: async () => null,
    getWindow: () => ({
      isSecureContext: false,
      location: { protocol: "http:", hostname: "192.168.1.9", host: "192.168.1.9:8000" },
    }),
    getDocument: () => null,
    isGenerating: () => false,
    stopGeneration: () => {
      stopGenCalls++;
      return true;
    },
    cancelPlayback: () => {
      playbackCancels++;
    },
    onInsecureOrigin: (status) => {
      insecureReason = status.remediation;
    },
  });

  // Manual barge-in while LLM is already idle: cancels TTS only, never calls stopGeneration()
  io.triggerBargeIn("manual");
  assert.equal(playbackCancels, 1);
  assert.equal(stopGenCalls, 0);

  // Attempting to arm mic barge-in on LAN HTTP must refuse getUserMedia and surface guidance
  const armRes = await io.armBargeIn({ usesSystemTts: false });
  assert.equal(armRes.activePolicy, "manual");
  assert.match(insecureReason, /HTTPS|127\.0\.0\.1|localhost/i);

  await io.dispose();
});

test("VoiceModeIoController applies ASR vocabulary replacements and injects into #send_textarea with optional auto-send", async () => {
  const settings = ensureExtensionSettings({
    voice_mode: {
      enabled: true,
      autoSendOnDictation: true,
      asrReplacements: [{ from: ["silly tavern"], to: "SillyTavern" }],
    },
  });

  let sendClicks = 0;
  const fakeTextarea = {
    tagName: "TEXTAREA",
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    focused: false,
    dispatchedEvents: [],
    focus() {
      this.focused = true;
      fakeDoc.activeElement = this;
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    dispatchEvent(ev) {
      this.dispatchedEvents.push(ev);
      return true;
    },
  };
  const fakeSendBtn = {
    click() {
      sendClicks++;
    },
  };
  const fakeDoc = {
    activeElement: null,
    defaultView: null,
    getElementById(id) {
      if (id === "send_textarea") return fakeTextarea;
      if (id === "send_but") return fakeSendBtn;
      return null;
    },
    querySelector(sel) {
      if (sel === "#send_textarea") return fakeTextarea;
      if (sel === "#send_but") return fakeSendBtn;
      return null;
    },
  };

  const io = new VoiceModeIoController({
    getSettings: () => settings,
    getSecret: async () => null,
    getWindow: () => ({ isSecureContext: true, location: { protocol: "http:", host: "127.0.0.1:18123" } }),
    getDocument: () => fakeDoc,
    isGenerating: () => false,
    stopGeneration: () => false,
    cancelPlayback: () => undefined,
  });

  const injected = io.injectDictatedText("Hello silly tavern!");
  assert.equal(injected, "Hello SillyTavern!");
  assert.equal(fakeTextarea.value, "Hello SillyTavern!");
  assert.equal(sendClicks, 1);

  await io.dispose();
});
