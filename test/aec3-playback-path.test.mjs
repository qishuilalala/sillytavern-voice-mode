/**
 * AEC3 playback-path regression suite (SillyTavern Voice Mode).
 *
 * Defect under reproduction: `src/runtime.ts` decides whether to arm hands-free AEC3
 * barge-in from `ttsHub.usesSystemTts` when the playback queue enters "playing"
 * (runtime.ts:240-247). That flag is snapshotted per utterance from the CONFIGURED
 * engine at enqueue time (tts-hub.ts:205-212) and the queue only emits a state
 * transition on idle -> playing (playback-queue.ts:154-156), never per utterance, so
 * the decision ignores what is actually played:
 *  - daemon/BYOK synthesis may fall back to OS `speechSynthesis` (`SYSTEM_TTS_MIME`);
 *    `onPlayStart` updates the actual engine afterwards (tts-hub.ts:129-133, 394-406),
 *    but the arm decision is never re-evaluated -> the mic stays armed while OS speech
 *    bypasses Chromium AEC3 -> OS voice echo self-triggers Voice Barge-In;
 *  - narration(system) <-> character(HTMLAudioElement/BYOK) switches inside one turn
 *    leave the queue in "playing": forward order never arms (hands-free barge-in
 *    silently unavailable), reverse order keeps the mic armed into OS speech.
 *
 * These scenarios drive the real entry points (`createVoiceModeRuntime`, which hosts
 * `VoiceModeTtsHub` + `VoiceModeIoController`) with the same fake SillyTavern
 * eventSource/host used by test/runtime-and-plugin.test.mjs. The microphone /
 * AudioWorklet device boundary is stubbed in-process (no real device, no network, no
 * machine state): `navigator.mediaDevices.getUserMedia`, `AudioContext` and
 * `AudioWorkletNode` are fakes that record mic open/stop windows and can push
 * 1024-sample (64 ms) speech frames into the real default capture path.
 *
 * Expected on HEAD 02424b5 (main): S1, S2a, S2b and the S6/S7 BYOK-fallback pair
 * are RED; S3/S4/S5 lock in the currently-correct behaviour.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { encodeMonoPcm16Wav } from "@voice-mode/core";
import { SYSTEM_TTS_MIME } from "@voice-mode/browser";
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
  APP_INITIALIZED: "app_initialized",
  APP_READY: "app_ready",
  CHAT_CHANGED: "chat_id_changed",
  GENERATION_STARTED: "generation_started",
  GENERATION_STOPPED: "generation_stopped",
  GENERATION_ENDED: "generation_ended",
  STREAM_TOKEN_RECEIVED: "stream_token_received",
  CHARACTER_MESSAGE_RENDERED: "character_message_rendered",
  USER_MESSAGE_RENDERED: "user_message_rendered",
  MESSAGE_SWIPED: "message_swiped",
  MESSAGE_DELETED: "message_deleted",
  GROUP_UPDATED: "group_updated",
  SECRET_WRITTEN: "secret_written",
  SECRET_DELETED: "secret_deleted",
  SECRET_ROTATED: "secret_rotated",
};

const WAV_MIME = "audio/wav";
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
    once(event, fn) {
      const wrapper = (...args) => {
        this.removeListener(event, wrapper);
        return fn(...args);
      };
      this.on(event, wrapper);
    },
    makeLast(event, fn) {
      this.on(event, fn);
    },
    removeListener(event, fn) {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((item) => item !== fn),
      );
    },
    async emit(event, ...args) {
      const list = [...(listeners.get(event) ?? [])];
      for (const fn of list) {
        await fn(...args);
      }
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
      const entry = {
        mime: payload.mime,
        bytes: payload.audio?.byteLength ?? 0,
        start: Date.now(),
        end: 0,
        aborted: false,
      };
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

/**
 * Device-boundary stub for the browser microphone path. The runtime host bridge has no
 * AEC3 capture-factory injection seam, so the real default `createBargeInMicCapture`
 * path is exercised against fake browser APIs while its open/stop windows are recorded.
 */
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

  const openIntervals = () =>
    state.streams.map((stream) => ({
      start: stream.openedAt,
      end: stream.track.stoppedAt || Infinity,
    }));

  const isMicOpenAt = (timestamp) =>
    state.streams.some(
      (stream) =>
        stream.openedAt <= timestamp &&
        (!stream.track.stoppedAt || stream.track.stoppedAt > timestamp),
    );

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
    openIntervals,
    isMicOpenAt,
    getUserMediaCount: () => state.getUserMediaCalls.length,
    openStreamCount: () => state.streams.filter((stream) => !stream.track.stoppedAt).length,
    pushSpeechFrames,
    restore,
  };
}

function createHostFixture({ fetchImpl, sink, bargeInMode, defaultVoice, narratorVoice, narrationSplitEnabled, generating = true, extraSettings = {} }) {
  const eventSource = createFakeEventSource();
  const extensionSettings = {
    voice_mode: {
      enabled: true,
      bargeInMode,
      defaultVoice,
      ...(narratorVoice ? { narratorVoice } : {}),
      ...(typeof narrationSplitEnabled === "boolean" ? { narrationSplitEnabled } : {}),
      ...extraSettings,
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
      void eventSource.emit(EVENT_TYPES.GENERATION_STOPPED);
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
    isGenerating: () => isGeneratingFlag,
    stopGenCalls: () => stopGenCalls,
  };
}

const byokFetch = async () =>
  new Response(WAV_BYTES, { status: 200, headers: { "content-type": WAV_MIME } });

/** S1: daemon offline -> OS speechSynthesis fallback must NOT arm AEC3. */
test("S1: kokoro-daemon offline system-TTS fallback must not arm AEC3 (arm by configured engine)", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 400 });
  let runtime;
  try {
    const fixture = createHostFixture({
      sink,
      bargeInMode: "detect",
      defaultVoice: { engine: "kokoro-daemon", voice: "zf_001" },
      narrationSplitEnabled: false,
      extraSettings: { daemonBaseUrl: "http://127.0.0.1:18790" },
      fetchImpl: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:18790");
      },
    });
    runtime = fixture.runtime;
    await runtime.activate();
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(
      EVENT_TYPES.STREAM_TOKEN_RECEIVED,
      "The daemon is offline so the operating system reads this sentence. ",
    );

    await waitFor(() => plays.some((play) => play.mime === SYSTEM_TTS_MIME && !play.end), {
      label: "system speechSynthesis playback after daemon fallback",
    });
    const systemPlay = plays.find((play) => play.mime === SYSTEM_TTS_MIME && !play.end);

    // Precondition: the configured engine is kokoro-daemon but the ACTUAL playback
    // path is system TTS; AEC3 arm policy must follow the actual path.
    const utterance = runtime.getDiagnostics().utteranceHistory[0];
    assert.ok(utterance, "expected the fallback utterance to reach playback");
    assert.equal(
      utterance.engine,
      "system",
      "precondition: daemon fallback must surface the actual playback engine 'system'",
    );

    // Sample the middle of the OS speech playback window: AEC3 must not be armed here.
    await waitFor(() => Date.now() >= systemPlay.start + 200, {
      label: "middle of system-TTS playback window",
    });
    const micArmedDuringSystemPlayback = device.isMicOpenAt(Date.now());

    // Consequence: OS voice echo captured by the still-armed mic self-triggers barge-in.
    await device.pushSpeechFrames(5);
    await sleep(250);
    assert.deepEqual(
      {
        configuredEngine: runtime.getSettings().defaultVoice.engine,
        actualPlaybackEngine: utterance.engine,
        micArmedDuringSystemPlayback,
        echoSelfTriggeredBargeIns: runtime.getDiagnostics().totalBargeIns,
        stopGenerationCalls: fixture.stopGenCalls(),
      },
      {
        configuredEngine: "kokoro-daemon",
        actualPlaybackEngine: "system",
        micArmedDuringSystemPlayback: false,
        echoSelfTriggeredBargeIns: 0,
        stopGenerationCalls: 0,
      },
      "S1: AEC3 arm decision followed the CONFIGURED engine, not the actual system playback path. " +
        "The configured engine was 'kokoro-daemon' but the daemon was offline and the utterance " +
        "actually played through window.speechSynthesis (SYSTEM_TTS_MIME). runtime.ts:240-247 " +
        "sampled ttsHub.usesSystemTts (tts-hub.ts:151-157), which was snapshotted from the " +
        "configured engine at enqueue time (tts-hub.ts:205-212); after the fallback the actual " +
        "engine only changes in onPlayStart/tts-hub.ts:129-133+394-406 and never re-triggers the " +
        "arm decision. OS speech bypasses Chromium AEC3, so the OS voice echo was captured as user " +
        "speech and self-interrupted playback + generation.",
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/** S2a: narration(system) -> character(BYOK WAV) must arm AEC3 for the character segment. */
test("S2a: character segment after a system narration must arm AEC3 (queue state never re-evaluates)", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 300 });
  let runtime;
  try {
    const fixture = createHostFixture({
      sink,
      fetchImpl: byokFetch,
      bargeInMode: "detect",
      defaultVoice: { engine: "openai-compat", voice: "alloy" },
      narratorVoice: { engine: "system", voice: "NarratorSys" },
      narrationSplitEnabled: true,
    });
    runtime = fixture.runtime;
    await runtime.activate();
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(
      EVENT_TYPES.STREAM_TOKEN_RECEIVED,
      "*Rain drummed on the roof.* ",
    );
    await fixture.eventSource.emit(
      EVENT_TYPES.STREAM_TOKEN_RECEIVED,
      "*Rain drummed on the roof.* Hello there. ",
    );

    await waitFor(() => plays.length >= 2 && plays.every((play) => play.end), {
      timeoutMs: 4000,
      label: "narrator + character playback",
    });
    assert.deepEqual(
      plays.map((play) => play.mime),
      [SYSTEM_TTS_MIME, WAV_MIME],
      "precondition: narrator plays via system TTS, then the character plays via HTMLAudioElement",
    );

    const wavPlay = plays[1];
    const wavMidpoint = Math.floor((wavPlay.start + wavPlay.end) / 2);
    assert.deepEqual(
      {
        playedMimes: plays.map((play) => play.mime),
        narratorEngine: runtime.getDiagnostics().utteranceHistory[0]?.engine,
        characterEngine: runtime.getDiagnostics().utteranceHistory[1]?.engine,
        characterSegmentArmedForAec3: device.isMicOpenAt(wavMidpoint),
      },
      {
        playedMimes: [SYSTEM_TTS_MIME, WAV_MIME],
        narratorEngine: "system",
        characterEngine: "openai-compat",
        characterSegmentArmedForAec3: true,
      },
      "S2a: the character segment played through HTMLAudioElement (audio/wav, AEC3-cancellable) " +
        "but the AEC3 monitor was never armed. The queue stayed in 'playing' between the system " +
        "narration and the character segment (playback-queue.ts:154-156 emits only idle->playing), " +
        "so runtime.ts:240-247 never re-ran its arm decision and ttsHub.usesSystemTts was " +
        "snapshotted from the narrator engine (tts-hub.ts:205-212). Hands-free barge-in is silently " +
        "unavailable for the rest of the turn.",
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/** S2b: character(BYOK WAV) -> narration(system) must disarm AEC3 for the system segment. */
test("S2b: system narration after a character segment must not keep AEC3 armed", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 300 });
  let runtime;
  try {
    const fixture = createHostFixture({
      sink,
      fetchImpl: byokFetch,
      bargeInMode: "detect",
      defaultVoice: { engine: "openai-compat", voice: "alloy" },
      narratorVoice: { engine: "system", voice: "NarratorSys" },
      narrationSplitEnabled: true,
    });
    runtime = fixture.runtime;
    await runtime.activate();
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "Hello there. ");
    await fixture.eventSource.emit(
      EVENT_TYPES.STREAM_TOKEN_RECEIVED,
      "Hello there. *Rain drummed on the roof.*",
    );

    await waitFor(
      () => plays.length >= 2 && plays[0].mime === WAV_MIME && plays[1].mime === SYSTEM_TTS_MIME,
      { timeoutMs: 4000, label: "character WAV then system narration playback" },
    );

    const wavPlay = plays[0];
    const wavMidpoint = Math.floor((wavPlay.start + wavPlay.end) / 2);

    const systemPlay = plays[1];
    await waitFor(() => Date.now() >= systemPlay.start + 150, {
      label: "middle of the system narration playback window",
    });
    const micArmedDuringSystemNarration = device.isMicOpenAt(Date.now());
    await device.pushSpeechFrames(5);
    await sleep(250);
    assert.deepEqual(
      {
        playedMimes: plays.map((play) => play.mime),
        characterSegmentArmedForAec3: device.isMicOpenAt(wavMidpoint),
        micArmedDuringSystemNarration,
        echoSelfTriggeredBargeIns: runtime.getDiagnostics().totalBargeIns,
        stopGenerationCalls: fixture.stopGenCalls(),
      },
      {
        playedMimes: [WAV_MIME, SYSTEM_TTS_MIME],
        characterSegmentArmedForAec3: true,
        micArmedDuringSystemNarration: false,
        echoSelfTriggeredBargeIns: 0,
        stopGenerationCalls: 0,
      },
      "S2b: AEC3 stayed armed across a character -> narrator switch, so the OS " +
        "window.speechSynthesis narration (SYSTEM_TTS_MIME) played with the microphone open. " +
        "The turn never left queue state 'playing' (playback-queue.ts:154-156), so " +
        "runtime.ts:240-247 never re-evaluated ttsHub.usesSystemTts (tts-hub.ts:151-157) after " +
        "the character HTMLAudioElement segment. OS speech bypasses AEC3, so its echo " +
        "self-interrupted playback and generation.",
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/** S3: bargeInMode=manual must never arm AEC3; manual barge-in stops playback/generation once. */
test("S3: manual barge-in never arms AEC3 and stops playback with exactly one guarded stopGeneration", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 600 });
  let runtime;
  try {
    const fixture = createHostFixture({
      sink,
      fetchImpl: byokFetch,
      bargeInMode: "manual",
      defaultVoice: { engine: "openai-compat", voice: "alloy" },
      narrationSplitEnabled: false,
    });
    runtime = fixture.runtime;
    await runtime.activate();
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "Wait for me. ");

    await waitFor(() => plays.length === 1 && plays[0].start > 0, { label: "playback start" });
    assert.equal(
      device.getUserMediaCount(),
      0,
      "S3: bargeInMode=manual must never open the AEC3 microphone",
    );

    runtime.triggerBargeIn("manual");
    await waitFor(() => fixture.stopGenCalls() === 1, { label: "stopGeneration after manual barge-in" });
    assert.equal(fixture.stopGenCalls(), 1, "S3: manual barge-in must call stopGeneration exactly once while generating");
    assert.equal(plays[0].aborted, true, "S3: manual barge-in must cancel HTMLAudioElement playback");
    assert.equal(device.openStreamCount(), 0, "S3: no AEC3 microphone may stay open after a manual barge-in");

    runtime.triggerBargeIn("manual");
    await sleep(50);
    assert.equal(
      fixture.stopGenCalls(),
      1,
      "S3: stopGeneration must stay guarded by isGenerating() after the first manual barge-in",
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/** S4: CHAT_CHANGED and dispose close the mic and later chunks are ignored. */
test("S4: CHAT_CHANGED and dispose stop microphone capture and ignore later chunks", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 800 });
  let runtime;
  try {
    const fixture = createHostFixture({
      sink,
      fetchImpl: byokFetch,
      bargeInMode: "detect",
      defaultVoice: { engine: "openai-compat", voice: "alloy" },
      narrationSplitEnabled: false,
    });
    runtime = fixture.runtime;
    await runtime.activate();
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "Keep talking to me. ");

    await waitFor(
      () => device.openStreamCount() > 0 && plays.some((play) => !play.end),
      { label: "AEC3 armed during BYOK playback" },
    );
    assert.equal(
      device.getUserMediaCount(),
      1,
      "precondition: normal HTMLAudioElement playback arms AEC3 once",
    );

    await fixture.eventSource.emit(EVENT_TYPES.CHAT_CHANGED, "chat-2");
    await waitFor(() => device.openStreamCount() === 0, {
      label: "CHAT_CHANGED closing the AEC3 microphone",
    });
    assert.equal(
      device.state.streams[0].track.stoppedAt > 0,
      true,
      "S4: CHAT_CHANGED must call capture.stop() on the armed AEC3 microphone",
    );

    const bargeInsBefore = runtime.getDiagnostics().totalBargeIns;
    const stopCallsBefore = fixture.stopGenCalls();
    await device.pushSpeechFrames(5);
    await sleep(120);
    assert.equal(
      runtime.getDiagnostics().totalBargeIns,
      bargeInsBefore,
      "S4: chunks delivered after CHAT_CHANGED must not be processed (stale monitor/epoch)",
    );
    assert.equal(fixture.stopGenCalls(), stopCallsBefore, "S4: stale chunks must not stop generation");

    // Re-arm on the next turn, then dispose while the mic is open.
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "Another line here. ");
    await waitFor(() => device.openStreamCount() > 0, { label: "AEC3 re-armed after CHAT_CHANGED" });
    await runtime.dispose();
    runtime = undefined;
    assert.equal(device.openStreamCount(), 0, "S4: dispose() must stop the armed AEC3 microphone");
    await device.pushSpeechFrames(5);
    await sleep(120);
    assert.equal(
      device.state.streams.every((stream) => stream.track.stoppedAt > 0),
      true,
      "S4: every captured stream must be stopped after dispose()",
    );
    // Coverage gap (implementation task): the runtime owns its VAD worker internally and
    // the host bridge exposes no worker-injection seam, so VAD worker release on dispose
    // cannot be observed here; this suite only asserts the externally reachable effects
    // above and the fact that dispose() resolves instead of hanging.
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/** S5: normal BYOK playback arms AEC3; 5x64ms speech frames barge in within 600ms. */
test("S5: normal BYOK playback arms AEC3 and confirmed speech (5x64ms) barges in under 600ms", async () => {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 1200 });
  let runtime;
  try {
    const fixture = createHostFixture({
      sink,
      fetchImpl: byokFetch,
      bargeInMode: "detect",
      defaultVoice: { engine: "openai-compat", voice: "alloy" },
      narrationSplitEnabled: false,
    });
    runtime = fixture.runtime;
    await runtime.activate();
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, "I am still speaking. ");

    await waitFor(
      () => device.openStreamCount() > 0 && plays.some((play) => !play.end),
      { label: "AEC3 armed during normal BYOK playback" },
    );

    const startedAt = performance.now();
    await device.pushSpeechFrames(5);
    await waitFor(() => fixture.stopGenCalls() === 1, {
      timeoutMs: 800,
      label: "AEC3 barge-in from 5x64ms confirmed speech frames",
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(runtime.getDiagnostics().totalBargeIns, 1, "S5: exactly one voice barge-in");
    assert.equal(fixture.stopGenCalls(), 1, "S5: voice barge-in stops the in-flight generation once");
    assert.ok(elapsedMs < 600, `S5: barge-in must fire in <600ms, got ${elapsedMs.toFixed(1)}ms`);
    assert.equal(plays[0].aborted, true, "S5: barge-in cancels HTMLAudioElement playback");
    assert.equal(device.openStreamCount(), 0, "S5: AEC3 monitor must stop the microphone after barge-in");
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
});

/**
 * S6/S7: BYOK (`openai-compat` / `mimo`) synthesis failure falls back to OS
 * `speechSynthesis` (`SYSTEM_TTS_MIME`). The fallback result must reach the queue as
 * the ACTUAL `system` engine (`tts-hub.ts` `markSystemFallbackEngine` rewrites
 * `pendingInfo.engine`), so the per-utterance AEC3 guard must never arm the microphone
 * for that sentence and playback must continue uninterrupted. On HEAD 02424b5 both
 * scenarios are RED: only the kokoro-daemon branch rewrote `pendingInfo.engine`, so
 * the runtime saw `engine="openai-compat"|"mimo"` while OS speech played and armed
 * AEC3 from the enqueue-time configured-engine prediction.
 */
async function assertByokSystemFallbackDoesNotArmAec3({ engine, extraSettings, label }) {
  const device = installDeviceBoundaryStub();
  const { sink, plays } = createRecordingSink({ playMs: 400 });
  let runtime;
  try {
    const fixture = createHostFixture({
      sink,
      bargeInMode: "detect",
      defaultVoice: { engine, voice: "alloy" },
      narrationSplitEnabled: false,
      extraSettings,
      fetchImpl: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED (BYOK endpoint offline)");
      },
    });
    runtime = fixture.runtime;
    await runtime.activate();
    await fixture.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, "normal", {}, false);
    await fixture.eventSource.emit(
      EVENT_TYPES.STREAM_TOKEN_RECEIVED,
      "The BYOK endpoint is offline so the operating system reads this sentence. ",
    );

    await waitFor(() => plays.some((play) => play.mime === SYSTEM_TTS_MIME && !play.end), {
      label: `${label}: system speechSynthesis playback after BYOK fallback`,
    });
    const systemPlay = plays.find((play) => play.mime === SYSTEM_TTS_MIME && !play.end);

    // Precondition: the configured engine is the BYOK provider but the ACTUAL playback
    // path is system TTS; the pendingInfo correction must surface the real engine.
    const utterance = runtime.getDiagnostics().utteranceHistory[0];
    assert.ok(utterance, `${label}: expected the fallback utterance to reach playback`);
    assert.equal(
      utterance.engine,
      "system",
      `${label}: BYOK synthesis failure must surface the actual playback engine 'system' ` +
        "(pendingInfo.engine rewrite), not the configured provider engine",
    );

    // Sample the middle of the OS speech playback window: AEC3 must not be armed.
    await waitFor(() => Date.now() >= systemPlay.start + 200, {
      label: `${label}: middle of system-TTS playback window`,
    });
    const micArmedDuringSystemPlayback = device.isMicOpenAt(Date.now());
    const getUserMediaCalls = device.getUserMediaCount();

    // OS voice echo captured by an armed mic would self-trigger barge-in here.
    await device.pushSpeechFrames(5);
    await sleep(250);
    await waitFor(() => plays[0].end > 0, { label: `${label}: fallback playback finishing` });

    assert.deepEqual(
      {
        playedMimes: plays.map((play) => play.mime),
        actualPlaybackEngine: utterance.engine,
        micArmedDuringSystemPlayback,
        getUserMediaCalls,
        micOpenAfterPlayback: device.openStreamCount(),
        echoSelfTriggeredBargeIns: runtime.getDiagnostics().totalBargeIns,
        stopGenerationCalls: fixture.stopGenCalls(),
        playbackContinues: plays[0].aborted === false,
      },
      {
        playedMimes: [SYSTEM_TTS_MIME],
        actualPlaybackEngine: "system",
        micArmedDuringSystemPlayback: false,
        getUserMediaCalls: 0,
        micOpenAfterPlayback: 0,
        echoSelfTriggeredBargeIns: 0,
        stopGenerationCalls: 0,
        playbackContinues: true,
      },
      `${label}: the ${engine} provider was offline and the sentence actually played through ` +
        "window.speechSynthesis (SYSTEM_TTS_MIME), but AEC3 was armed from the configured " +
        "provider engine and/or the actual engine was not surfaced; OS speech bypasses " +
        "Chromium AEC3, so its echo self-interrupts playback.",
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    device.restore();
  }
}

test("S6: openai-compat offline system-TTS fallback must not arm AEC3", async () => {
  await assertByokSystemFallbackDoesNotArmAec3({
    engine: "openai-compat",
    extraSettings: { openaiTtsBaseUrl: "http://127.0.0.1:18792/v1" },
    label: "S6",
  });
});

test("S7: mimo offline system-TTS fallback must not arm AEC3", async () => {
  await assertByokSystemFallbackDoesNotArmAec3({
    engine: "mimo",
    extraSettings: { mimoBaseUrl: "http://127.0.0.1:18791" },
    label: "S7",
  });
});
