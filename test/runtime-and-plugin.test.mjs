import assert from "node:assert/strict";
import test from "node:test";

import { EMOTION_PROMPT_KEY } from "../src/settings.ts";
import { createVoiceModeRuntime } from "../src/runtime.ts";
import { exit as pluginExit, info as pluginInfo, init as pluginInit } from "../server-plugin/index.mjs";

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

test("VoiceModeRuntime wires SillyTavern events, starts TTS before GENERATION_ENDED, registers emotion prompt, and aborts generation on barge-in", async () => {
  const eventSource = createFakeEventSource();
  const prompts = new Map();
  const extensionSettings = {
    voice_mode: {
      enabled: true,
      emotionPromptEnabled: true,
      narrationSplitEnabled: true,
      bargeInMode: "manual",
      defaultVoice: { engine: "system", voice: "CharVoice" },
      narratorVoice: { engine: "system", voice: "NarratorVoice" },
      voiceMap: {
        "seraphina.png": { engine: "system", voice: "SeraphinaVoice" },
      },
    },
  };

  let generating = false;
  let stopGenCalls = 0;
  const playedUtterances = [];

  const runtime = createVoiceModeRuntime({
    eventSource,
    eventTypes: {
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
    },
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
      streamingProcessor: generating ? { isFinished: false, isStopped: false } : null,
      extensionSettings,
      saveSettingsDebounced: () => undefined,
      stopGeneration: () => {
        stopGenCalls++;
        generating = false;
        return true;
      },
      setExtensionPrompt: () => undefined,
    }),
    saveSettingsDebounced: () => undefined,
    isGenerating: () => generating,
    stopGeneration: () => {
      stopGenCalls++;
      generating = false;
      void eventSource.emit("generation_stopped");
      return true;
    },
    setExtensionPrompt: (key, value, position, depth, scan, role) => {
      prompts.set(key, { value, position, depth, scan, role });
    },
    getRequestHeaders: () => ({ "Content-Type": "application/json" }),
    secrets: {
      writeSecret: async () => "sec-1",
      findSecret: async () => null,
      deleteSecret: async () => undefined,
    },
    sink: {
      async play(payload, signal) {
        playedUtterances.push({ at: Date.now(), bytes: payload.audio.byteLength });
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 40);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      },
    },
  });

  await runtime.activate();

  // Emotion DSL prompt registered via setExtensionPrompt
  const registeredPrompt = prompts.get(EMOTION_PROMPT_KEY);
  assert.ok(registeredPrompt);
  assert.match(registeredPrompt.value, /<whisper>|<break/i);
  assert.equal(registeredPrompt.position, 1);
  assert.equal(registeredPrompt.role, 0);

  // Streaming generation: sentence 1 must begin TTS BEFORE GENERATION_ENDED
  generating = true;
  await eventSource.emit("generation_started", "normal", {}, false);
  await eventSource.emit("stream_token_received", "*The wind howled.* ");

  // Allow PlaybackQueue async synthesize -> onPlayStart
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(playedUtterances.length, 1, "First sentence must start playing before GENERATION_ENDED");

  await eventSource.emit("stream_token_received", '*The wind howled.* "Welcome home."');
  await new Promise((r) => setTimeout(r, 25));
  generating = false;
  await eventSource.emit("generation_ended", 1);
  await runtime.waitUntilIdle();

  const diag = runtime.getDiagnostics();
  assert.ok(diag.firstSentenceLeadMs > 0, `Expected firstSentenceLeadMs > 0, got ${diag.firstSentenceLeadMs}`);
  assert.equal(diag.utteranceHistory.length, 2);
  assert.equal(diag.utteranceHistory[0].voice, "NarratorVoice");
  assert.equal(diag.utteranceHistory[1].voice, "SeraphinaVoice");

  // Mid-stream barge-in cancels playback AND calls stopGeneration()
  generating = true;
  await eventSource.emit("generation_started", "normal", {}, false);
  await eventSource.emit("stream_token_received", '"Wait, listen carefully to me. ');
  await new Promise((r) => setTimeout(r, 10));
  runtime.triggerBargeIn("manual");
  assert.equal(stopGenCalls, 1);
  assert.equal(generating, false);

  await runtime.dispose();
});

test("Optional server-plugin exports valid SillyTavern plugin contract and blocks SSRF targets", async () => {
  assert.match(pluginInfo.id, /^[a-z0-9_-]+$/);
  assert.equal(pluginInfo.id, "voice-mode");

  const routes = new Map();
  const fakeRouter = {
    get(routePath, handler) {
      routes.set(`GET ${routePath}`, handler);
    },
    post(routePath, handler) {
      routes.set(`POST ${routePath}`, handler);
    },
  };

  await pluginInit(fakeRouter);
  assert.ok(routes.has("GET /health"));
  assert.ok(routes.has("POST /tts"));

  let statusSent = 200;
  let bodySent = null;
  const res = {
    status(code) {
      statusSent = code;
      return this;
    },
    json(payload) {
      bodySent = payload;
      return this;
    },
  };

  // Attempt SSRF to private LAN metadata IP -> must reject with 400
  await routes.get("POST /tts")(
    {
      body: {
        targetUrl: "http://169.254.169.254/latest/meta-data/",
        secretSlot: "openaiTts",
        upstreamBody: "{}",
      },
      user: { directories: { root: "/tmp" } },
    },
    res,
  );
  assert.equal(statusSent, 400);
  assert.match(String(bodySent?.error ?? ""), /Disallowed|HTTPS|loopback/i);

  await pluginExit();
});
