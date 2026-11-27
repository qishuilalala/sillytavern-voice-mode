/**
 * Barge-in state regression suite (st-audit2 D1 + D2).
 *
 * D1 (important, privacy + phantom cancellation): a short reply can finish playing
 * while the host is still generating. The playback queue then returns to "idle" and
 * `runtime.ts` correctly skips the disarm because `isHostGenerating()` is still true;
 * afterwards `GENERATION_ENDED` used to only flush the router and never settle the
 * microphone, so an armed AEC3 monitor stayed open indefinitely (browser recording
 * indicator on). Speech in the gap between turns was then confirmed as Voice Barge-In
 * and cancelled the next generation before its first sentence played.
 * Fix: the `GENERATION_ENDED` handler settles the guard when the queue is idle and the
 * host is no longer generating (tail sentences keep the queue playing, so it skips).
 *
 * D2 (medium, violates an explicit privacy choice): switching `bargeInMode` to
 * "manual" during playback did not stop an already armed microphone; the per-utterance
 * guard only re-evaluates on the next utterance's engine change. Manual means
 * "button/hotkey only", so an armed monitor must be disarmed immediately.
 * Fix: `updateSettings` resets the guard when the normalized mode is "manual";
 * switching back to detect/auto never arms eagerly — the next utterance takes over.
 *
 * Device boundary (microphone / AudioWorklet) is stubbed in-process like
 * `test/aec3-playback-path.test.mjs`; no real device, network, or machine state.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { encodeMonoPcm16Wav } from "@voice-mode/core";
import { createVoiceModeRuntime } from "../src/runtime.ts";

const SECURE_WINDOW = {
  isSecureContext: true,
  location: { protocol: "http:", host: "127.0.0.1:18000" },
  navigator: {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  },
};

const EVENT_TYPES = {
  APP_READY: "app_ready",
  CHAT_CHANGED: "chat_id_changed",
  GENERATION_STARTED: "generation_started",
  GENERATION_STOPPED: "generation_stopped",
  GENERATION_ENDED: "generation_ended",
  STREAM_TOKEN_RECEIVED: "stream_token_received",
  CHARACTER_MESSAGE_RENDERED: "character_message_rendered",
  MESSAGE_SWIPED: "message_swiped",
  MESSAGE_DELETED: "message_deleted",
  GROUP_UPDATED: "group_updated",
};

const WAV_BYTES = encodeMonoPcm16Wav(new Float32Array(960).fill(0.1), 16000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 4000, intervalMs = 5, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function createFakeEventSource() {
  const listeners = new Map();
  return {
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    makeLast(event, fn) {
      this.on(event, fn);
    },
    removeListener(event, fn) {
      const list = listeners.get(event) ?? [];
      listeners.set(event, list.filter((item) => item !== fn));
    },
    async emit(event, ...args) {
      const list = [...(listeners.get(event) ?? [])];
      for (const fn of list) await fn(...args);
    },
  };
}

/** 1024 samples @ 16 kHz = 64 ms, matching DEFAULT_BARGE_IN_CHUNK_SAMPLES. */
function makeSpeechFrame({ samples = 1024, freqHz = 300, amplitude = 0.18, sampleRate = 16000 } = {}) {
  const frame = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    frame[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return frame;
}

function createRecordingSink({ playMs }) {
  const plays = [];
  const sink = {
    async play(payload, signal) {
      const entry = { mime: payload.mime, start: Date.now(), end: 0, aborted: false };
      plays.push(entry);
      await new Promise((resolve) => {
        const finish = (aborted) => {
          if (entry.end) return;
          entry.end = Date.now();
          entry.aborted = aborted;
          resolve();
        };
        const timer = setTimeout(() => finish(false), playMs);
        if (signal.aborted) {
          clearTimeout(timer);
          finish(true);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            finish(true);
          },
          { once: true },
        );
      });
    },
  };
  return { sink, plays };
}

/** Device boundary stub: fake navigator.mediaDevices / AudioContext / AudioWorkletNode (aec3 suite style). */
function installDeviceBoundaryStub() {
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    AudioContext: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
    AudioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode"),
  };
  const state = { getUserMediaCalls: [], streams: [], worklets: [] };

  const trackFor = (stream) => ({
    getSettings: () => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      sampleRate: 16000,
      channelCount: 1,
    }),
    stop() {
      if (!stream.track.stoppedAt) stream.track.stoppedAt = Date.now();
    },
  });

  const mediaDevices = {
    async getUserMedia(constraints) {
      const call = { at: Date.now(), constraints };
      state.getUserMediaCalls.push(call);
      const stream = { openedAt: call.at, track: { stoppedAt: 0 } };
      stream.track = trackFor(stream);
      stream.getAudioTracks = () => [stream.track];
      stream.getTracks = () => [stream.track];
      state.streams.push(stream);
      return stream;
    },
    getSupportedConstraints: () => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }),
  };

  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage: () => {} };
      this.onprocessorerror = null;
      state.worklets.push(this);
    }
    connect() {}
    disconnect() {}
  }

  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    createMediaStreamSource() {
      return { connect: () => {}, disconnect: () => {} };
    }
    createGain() {
      return { gain: { value: 0 }, connect: () => {}, disconnect: () => {} };
    }
    async resume() {
      this.state = "running";
    }
    async close() {
      this.state = "closed";
    }
  }

  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices }, configurable: true });
  Object.defineProperty(globalThis, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: FakeAudioWorkletNode,
    configurable: true,
    writable: true,
  });

  const activeWorklet = () => {
    for (let i = state.worklets.length - 1; i >= 0; i--) {
      if (typeof state.worklets[i].port.onmessage === "function") return state.worklets[i];
    }
    return null;
  };

  const pushFrame = (frame) => {
    const worklet = activeWorklet();
    if (!worklet) return false;
    worklet.port.onmessage({ data: frame });
    return true;
  };

  const pushSpeechFrames = async (count = 5, { gapMs = 4 } = {}) => {
    for (let i = 0; i < count; i++) {
      if (!pushFrame(makeSpeechFrame())) return false;
      await sleep(gapMs);
    }
    return true;
  };

  const restore = () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };

  return {
    state,
    getUserMediaCount: () => state.getUserMediaCalls.length,
    openStreamCount: () => state.streams.filter((stream) => !stream.track.stoppedAt).length,
    pushSpeechFrames,
    restore,
  };
}

function createHostFixture({ fetchImpl, sink, generating = true }) {
  const eventSource = createFakeEventSource();
  const extensionSettings = {
    voice_mode: {
      enabled: true,
      bargeInMode: "detect",
      defaultVoice: { engine: "openai-compat", voice: "alloy" },
      narrationSplitEnabled: false,
    },
  };
  let isGeneratingFlag = generating;
  let stopGenCalls = 0;

  const runtime = createVoiceModeRuntime({
    eventSource,
    eventTypes: EVENT_TYPES,
    extensionPromptTypes: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extensionPromptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extensionSettings,
    getContext: () => ({
      chat: [],
      characters: [{ name: "Seraphina", avatar: "seraphina.png" }],
      groups: [],
      name1: "User",
      name2: "Seraphina",
      characterId: 0,
      groupId: null,
      chatId: "chat-1",
      streamingProcessor: isGeneratingFlag ? { isFinished: false, isStopped: false } : null,
    }),
    saveSettingsDebounced: () => {},
    isGenerating: () => isGeneratingFlag,
    stopGeneration: () => {
      stopGenCalls++;
      isGeneratingFlag = false;
      return true;
    },
    setExtensionPrompt: () => {},
    getRequestHeaders: () => ({ "Content-Type": "application/json" }),
    secrets: {
      writeSecret: async () => "sec-1",
      findSecret: async () => null,
      deleteSecret: async () => undefined,
    },
    fetchImpl,
    sink,
    getWindow: () => SECURE_WINDOW,
    getDocument: () => null,
  });

  return {
    runtime,
    eventSource,
    setGenerating: (v) => {
      isGeneratingFlag = v;
    },
    stopGenCalls: () => stopGenCalls,
  };
}

const byokFetch = async () =>
  new Response(WAV_BYTES, { status: 200, headers: { "content-type": "audio/wav" } });

/** RT-1 (D1): a short reply drains the queue before GENERATION_ENDED -> the turn must close the mic. */
test("RT-1 (D1): short reply that finishes playing before GENERATION_ENDED must close the AEC3 microphone", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 120 });
  let runtime;
  try {
    const fixture = createHostFixture({ sink, fetchImpl: byokFetch });
    runtime = fixture.runtime;
    await runtime.activate();

    // Turn 1: a single short sentence finishes playing while the host is still generating.
    fixture.setGenerating(true);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "Hi. ");
    await waitFor(() => plays.length === 1 && plays[0].end > 0, { label: "turn-1 playback finished" });
    await waitFor(() => device.openStreamCount() === 1, { label: "AEC3 armed during playback" });

    // The queue goes idle while isHostGenerating() is still true, so the idle handler
    // intentionally skips the disarm (more sentences could still arrive).
    await sleep(60);
    assert.equal(
      device.openStreamCount(),
      1,
      "precondition: the idle transition before GENERATION_ENDED keeps the mic armed mid-turn",
    );

    // Generation formally ends with nothing left to flush (queue already idle).
    fixture.setGenerating(false);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, 1);
    await waitFor(() => device.openStreamCount() === 0, {
      timeoutMs: 1500,
      label: "GENERATION_ENDED closing the leftover armed AEC3 microphone",
    });
    assert.equal(
      device.getUserMediaCount(),
      1,
      "RT-1: the microphone was armed once during playback and closed at turn end (no reopen)",
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/** RT-1b (D1 consequence): leftover armed mic between turns must not cancel the next generation. */
test("RT-1b (D1): leftover armed microphone must not treat between-turn speech as barge-in", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 120 });
  let runtime;
  try {
    const fixture = createHostFixture({ sink, fetchImpl: byokFetch });
    runtime = fixture.runtime;
    await runtime.activate();

    // Turn 1: same short-reply sequence as RT-1.
    fixture.setGenerating(true);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "Hi. ");
    await waitFor(() => plays.length === 1 && plays[0].end > 0, { label: "turn-1 playback finished" });
    fixture.setGenerating(false);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, 1);
    await waitFor(() => device.openStreamCount() === 0, {
      timeoutMs: 1500,
      label: "microphone closed after turn 1",
    });
    const bargeInsBefore = runtime.getDiagnostics().totalBargeIns;

    // Turn 2 starts; no sentence has been synthesized/played yet.
    fixture.setGenerating(true);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await sleep(30);

    // The user talks normally to the room between turns (not a barge-in request).
    await device.pushSpeechFrames(5);
    await sleep(250);

    assert.deepEqual(
      {
        micOpenBetweenTurns: device.openStreamCount(),
        bargeInsSinceTurnEnd: runtime.getDiagnostics().totalBargeIns - bargeInsBefore,
        stopGenerationCalls: fixture.stopGenCalls(),
        turn2PlaybackStarted: plays.length > 1,
      },
      {
        micOpenBetweenTurns: 0,
        bargeInsSinceTurnEnd: 0,
        stopGenerationCalls: 0,
        turn2PlaybackStarted: false,
      },
      "RT-1b: with the mic closed at turn end, between-turn speech cannot self-trigger " +
        "barge-in or cancel the next generation before its first sentence",
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/** RT-2 (D2): switching to manual during playback stops the armed mic; switching back re-arms next turn. */
test("RT-2 (D2): switching bargeInMode to manual mid-playback must disarm; switching back re-arms next turn", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 600 });
  let runtime;
  try {
    const fixture = createHostFixture({ sink, fetchImpl: byokFetch });
    runtime = fixture.runtime;
    await runtime.activate();

    // Turn 1: a long sentence starts playing and arms AEC3.
    fixture.setGenerating(true);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "Speaking a long line now. ");
    await waitFor(() => device.openStreamCount() === 1, { label: "AEC3 armed during playback" });

    // The user picks "Manual Button / Hotkey Only" in the settings drawer.
    runtime.updateSettings((draft) => {
      draft.bargeInMode = "manual";
    });
    await waitFor(() => device.openStreamCount() === 0, {
      timeoutMs: 1500,
      label: "manual mode stopping the already armed microphone",
    });
    assert.equal(runtime.getSettings().bargeInMode, "manual", "precondition: the setting persisted");

    // Switching back must not arm eagerly...
    runtime.updateSettings((draft) => {
      draft.bargeInMode = "detect";
    });
    await sleep(80);
    assert.equal(
      device.openStreamCount(),
      0,
      "RT-2: selecting detect again must not re-arm until the next utterance starts playing",
    );

    // ...the next utterance/turn takes over and arms normally.
    await waitFor(() => plays.length === 1 && plays[0].end > 0, { label: "turn-1 playback finished" });
    fixture.setGenerating(false);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, 1);
    fixture.setGenerating(true);
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "A second reply arrives. ");
    await waitFor(() => device.openStreamCount() === 1, {
      label: "AEC3 re-armed by the next turn after switching back to detect",
    });
    assert.equal(
      device.getUserMediaCount(),
      2,
      "RT-2: exactly one microphone open during turn 1 and one re-open for turn 2",
    );
    assert.equal(plays.length, 2, "RT-2: the next turn's sentence plays while armed");
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});
