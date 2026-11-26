import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  // Emotion DSL prompt registered via setExtensionPrompt (with allowRoleplayNarration: true)
  const registeredPrompt = prompts.get(EMOTION_PROMPT_KEY);
  assert.ok(registeredPrompt);
  assert.match(registeredPrompt.value, /<whisper>|<break/i);
  assert.doesNotMatch(registeredPrompt.value, /stage-direction asterisks/i);
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
      headers: { "sec-fetch-site": "same-origin" },
      body: {
        presetId: "custom",
        customBaseUrl: "http://169.254.169.254/latest/meta-data/",
        secretSlot: "openaiTts",
        upstreamBody: "{}",
      },
      user: { directories: { root: "/tmp" } },
    },
    res,
  );
  assert.equal(statusSent, 400);
  assert.match(String(bodySent?.error ?? ""), /Disallowed|HTTPS/i);

  await pluginExit();
});

function createMiniDom() {
  const byId = new Map();
  class MiniElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = "";
      this.textContent = "";
      this.value = "";
      this.type = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.placeholder = "";
      this.autocomplete = "";
      this.selected = false;
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this._id = "";
    }
    get id() {
      return this._id;
    }
    set id(v) {
      this._id = v;
      if (v) byId.set(v, this);
    }
    setAttribute(k, v) {
      this[k] = v;
    }
    appendChild(child) {
      this.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }
    addEventListener(ev, fn) {
      const list = this.listeners.get(ev) ?? [];
      list.push(fn);
      this.listeners.set(ev, list);
    }
    removeEventListener(ev, fn) {
      const list = this.listeners.get(ev) ?? [];
      this.listeners.set(ev, list.filter((x) => x !== fn));
    }
    dispatch(ev) {
      for (const fn of this.listeners.get(ev) ?? []) fn({ preventDefault() {} });
    }
    click() {
      this.dispatch("click");
    }
  }
  const container = new MiniElement("div");
  container.id = "extensions_settings";
  return {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new MiniElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function createDrawerFixture({ translate, secrets, secure = true, firstCharacter = "Alice", chat = [], defaultEngine = "system" } = {}) {
  const eventSource = createFakeEventSource();
  const doc = createMiniDom();
  const extensionSettings = {
    voice_mode: {
      enabled: true,
      ...(defaultEngine !== "system"
        ? { defaultVoice: { engine: defaultEngine, voice: "" } }
        : {}),
    },
  };
  let activeIdx = 0;
  const characters = [
    { name: firstCharacter, avatar: "alice.png" },
    { name: "Bob", avatar: "bob.png" },
  ];

  const runtime = createVoiceModeRuntime({
    eventSource,
    eventTypes: {
      APP_READY: "app_ready",
      CHAT_CHANGED: "chat_id_changed",
      GROUP_UPDATED: "group_updated",
      GENERATION_STARTED: "generation_started",
      GENERATION_STOPPED: "generation_stopped",
      GENERATION_ENDED: "generation_ended",
      STREAM_TOKEN_RECEIVED: "stream_token_received",
      CHARACTER_MESSAGE_RENDERED: "character_message_rendered",
      MESSAGE_SWIPED: "message_swiped",
      MESSAGE_DELETED: "message_deleted",
    },
    extensionPromptTypes: { IN_CHAT: 1 },
    extensionPromptRoles: { SYSTEM: 0 },
    extensionSettings,
    getContext: () => ({
      chat,
      characters,
      groups: [],
      name1: "User",
      name2: characters[activeIdx].name,
      characterId: activeIdx,
      groupId: null,
      chatId: "c1",
      streamingProcessor: null,
    }),
    saveSettingsDebounced: () => {},
    isGenerating: () => false,
    stopGeneration: () => false,
    setExtensionPrompt: () => {},
    getRequestHeaders: () => ({}),
    translate,
    secrets: secrets ?? { writeSecret: async () => "1", findSecret: async () => null, deleteSecret: async () => {} },
    getWindow: () => ({ isSecureContext: secure, location: { protocol: "http:", host: "example.test:8000" } }),
    getDocument: () => doc,
  });

  return { doc, runtime, eventSource, selectCharacter: (index) => { activeIdx = index; } };
}

test("Settings drawer binds active character voiceMap overrides on CHAT_CHANGED and exposes endpoint + proxy controls", async () => {
  const { doc, runtime, eventSource, selectCharacter } = createDrawerFixture();
  await runtime.activate();

  const charLabel = doc.getElementById("vm_st_active_char_label");
  const charEngine = doc.getElementById("vm_st_char_engine");
  const charVoice = doc.getElementById("vm_st_char_voice");
  const charReset = doc.getElementById("vm_st_char_reset_btn");
  const openaiUrl = doc.getElementById("vm_st_openai_tts_base_url");
  const asrUrl = doc.getElementById("vm_st_asr_base_url");
  const daemonUrl = doc.getElementById("vm_st_daemon_base_url");
  const proxyToggle = doc.getElementById("vm_st_use_server_proxy");

  assert.ok(charLabel && charEngine && charVoice && charReset);
  assert.ok(openaiUrl && asrUrl && daemonUrl && proxyToggle);
  assert.match(charLabel.textContent, /Alice/);

  // Bind voiceMap override for Alice
  charEngine.value = "kokoro-daemon";
  charVoice.value = "zf_001";
  charVoice.dispatch("change");
  assert.deepEqual(runtime.getSettings().voiceMap["alice.png"], {
    engine: "kokoro-daemon",
    voice: "zf_001",
  });

  // Switch active character to Bob and emit CHAT_CHANGED -> UI refreshes to empty override
  selectCharacter(1);
  await eventSource.emit("chat_id_changed", "c2");
  assert.match(charLabel.textContent, /Bob/);
  assert.equal(charEngine.value, "");
  assert.equal(charVoice.value, "");

  // Switch back to Alice -> UI restores Alice's override, then Reset clears it
  selectCharacter(0);
  await eventSource.emit("chat_id_changed", "c1");
  assert.equal(charEngine.value, "kokoro-daemon");
  assert.equal(charVoice.value, "zf_001");
  charReset.click();
  assert.equal(runtime.getSettings().voiceMap["alice.png"], undefined);

  // Endpoint & proxy controls update settings
  openaiUrl.value = "https://tts.example/v1";
  openaiUrl.dispatch("change");
  asrUrl.value = "https://asr.example/v1";
  asrUrl.dispatch("change");
  daemonUrl.value = "http://127.0.0.1:18799";
  daemonUrl.dispatch("change");
  proxyToggle.checked = true;
  proxyToggle.dispatch("change");

  const updated = runtime.getSettings();
  assert.equal(updated.openaiTtsBaseUrl, "https://tts.example/v1");
  assert.equal(updated.asrBaseUrl, "https://asr.example/v1");
  assert.equal(updated.daemonBaseUrl, "http://127.0.0.1:18799");
  assert.equal(updated.useServerPluginProxy, true);

  await runtime.dispose();
});


const chineseCatalog = JSON.parse(readFileSync(new URL("../locales/zh-cn.json", import.meta.url), "utf8"));

test("Settings drawer uses the SillyTavern locale and falls back to English per string", async (t) => {
  const firstCharacter = '<img src=x> $& {0}';
  const partialCatalog = { ...chineseCatalog };
  delete partialCatalog["voice_mode.barge"];

  for (const { name, catalog, chinese, barge } of [
    { name: "Simplified Chinese", catalog: chineseCatalog, chinese: true, barge: "打断朗读与生成" },
    { name: "another SillyTavern locale", catalog: {}, chinese: false, barge: "Stop / Barge-In" },
    { name: "missing translation", catalog: partialCatalog, chinese: true, barge: "Stop / Barge-In" },
  ]) {
    await t.test(name, async () => {
      const { doc, runtime } = createDrawerFixture({
        firstCharacter,
        secure: false,
        translate: (fallback, key) => catalog[key] || fallback,
      });
      try {
        await runtime.activate();
        const drawer = doc.getElementById("voice_mode_settings_drawer");
        const [header, content] = drawer.children;
        assert.equal(header.children[0].textContent, chinese ? "语音模式" : "Voice Mode");
        assert.equal(header.children[1].textContent, chinese ? "就绪" : "Ready");
        assert.equal(
          doc.getElementById("vm_st_active_char_label").textContent,
          chinese ? '当前角色音色：' + firstCharacter : 'Active Character Voice: ' + firstCharacter,
        );
        const dictate = doc.getElementById("vm_st_dictate_btn");
        assert.equal(dictate.textContent, chinese ? "开始听写" : "Dictate Mic");
        const exportWav = doc.getElementById("vm_st_export_wav_btn");
        assert.equal(exportWav.textContent, chinese ? "导出最近回复为 WAV" : "Export last reply as WAV");
        const diagBtn = doc.getElementById("vm_st_copy_diagnostics_btn");
        assert.equal(diagBtn.textContent, chinese ? "复制诊断信息" : "Copy diagnostics");
        const exportChat = doc.getElementById("vm_st_export_chat_btn");
        assert.equal(exportChat.textContent, chinese ? "导出最近 10 条回复为 WAV" : "Export last 10 replies as WAV");
        assert.equal(dictate.disabled, true);
        assert.equal(doc.getElementById("vm_st_barge_in_btn").textContent, barge);
        const banner = content.children[0];
        assert.equal(banner.hidden, false);
        assert.match(banner.textContent, /http:\/\/example\.test:8000/);
        assert.match(banner.textContent, chinese ? /远程访问时可使用 SSH/ : /forward the port over SSH/);
        assert.deepEqual(
          doc.getElementById("vm_st_asr_engine").children.map((option) => option.value),
          ["system", "daemon", "openai-compat"],
        );
      } finally {
        await runtime.dispose();
      }
    });
  }
});

test("Settings drawer reports a rejected secret write in the selected locale", async () => {
  const { doc, runtime } = createDrawerFixture({
    translate: (fallback, key) => chineseCatalog[key] || fallback,
    secrets: {
      writeSecret: async () => null,
      findSecret: async () => null,
      deleteSecret: async () => {},
    },
  });
  await runtime.activate();
  try {
    const secretInput = doc.getElementById("vm_st_secret_input");
    const saveButton = doc.getElementById("vm_st_save_secret_btn");
    doc.getElementById("vm_st_secret_slot").value = "asr";
    secretInput.value = "sample-key";
    saveButton.click();
    assert.equal(saveButton.disabled, true);
    await new Promise((resolve) => setImmediate(resolve));
    const status = doc.getElementById("voice_mode_settings_drawer").children[0].children[1];
    assert.match(status.textContent, /无法更新服务端密钥/);
    assert.equal(saveButton.disabled, false);
    assert.equal(secretInput.value, "");
  } finally {
    await runtime.dispose();
  }
});

test("VoiceModeRuntime resolves the group-chat speaker from the generated message so Voice Map matches", async () => {
  const eventSource = createFakeEventSource();
  const extensionSettings = {
    voice_mode: {
      enabled: true,
      emotionPromptEnabled: false,
      narrationSplitEnabled: false,
      bargeInMode: "manual",
      defaultVoice: { engine: "system", voice: "DefaultVoice" },
      narratorVoice: { engine: "system", voice: "NarratorVoice" },
      voiceMap: { "seraphina.png": { engine: "system", voice: "SeraphinaVoice" } },
    },
  };
  let generating = false;

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
      // Group chat: characterId is unset; the generated message carries the speaker.
      chat: [
        {
          name: "Seraphina",
          original_avatar: "seraphina.png",
          is_user: false,
          is_system: false,
          mes: "",
        },
      ],
      characters: [{ name: "Seraphina", avatar: "seraphina.png" }],
      groups: [{ id: "g1", name: "Group Chat", members: ["Seraphina"] }],
      name1: "User",
      name2: "Group Chat",
      characterId: undefined,
      groupId: "g1",
      chatId: "chat-g1",
      streamingProcessor: generating ? { isFinished: false, isStopped: false } : null,
    }),
    saveSettingsDebounced: () => undefined,
    isGenerating: () => generating,
    stopGeneration: () => {
      generating = false;
      return true;
    },
    setExtensionPrompt: () => undefined,
    getRequestHeaders: () => ({ "Content-Type": "application/json" }),
    secrets: {
      writeSecret: async () => "sec-1",
      findSecret: async () => null,
      deleteSecret: async () => undefined,
    },
    sink: {
      async play() {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    },
  });

  await runtime.activate();
  generating = true;
  await eventSource.emit("generation_started", "normal", {}, false);
  await eventSource.emit("stream_token_received", "Group reply from Seraphina. ");
  await new Promise((r) => setTimeout(r, 80));
  await runtime.waitUntilIdle();

  const diag = runtime.getDiagnostics();
  assert.ok(diag.utteranceHistory.length >= 1, "expected at least one utterance");
  assert.equal(
    diag.utteranceHistory[0].voice,
    "SeraphinaVoice",
    `group speaker must map to the character voice, got ${diag.utteranceHistory[0].voice}`,
  );

  await runtime.dispose();
});


test("Export button reports an empty chat instead of failing silently", async () => {
  const { doc, runtime } = createDrawerFixture({
    translate: (fallback, key) => chineseCatalog[key] || fallback,
  });
  try {
    await runtime.activate();
    const exportBtn = doc.getElementById("vm_st_export_wav_btn");
    exportBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const badge = doc.getElementById("voice_mode_settings_drawer").children[0].children[1];
    assert.equal(badge.textContent, "没有可导出的回复。");
  } finally {
    await runtime.dispose();
  }
});


test("Diagnostics button reports a clipboard failure instead of failing silently", async () => {
  const { doc, runtime } = createDrawerFixture({
    translate: (fallback, key) => chineseCatalog[key] || fallback,
  });
  try {
    await runtime.activate();
    const badge = doc.getElementById("voice_mode_settings_drawer").children[0].children[1];
    doc.getElementById("vm_st_copy_diagnostics_btn").click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(badge.textContent, "无法复制诊断信息（剪贴板不可用）。");
  } finally {
    await runtime.dispose();
  }
});


test("Export chat button reports an empty chat instead of failing silently", async () => {
  const { doc, runtime } = createDrawerFixture({
    translate: (fallback, key) => chineseCatalog[key] || fallback,
  });
  try {
    await runtime.activate();
    const badge = doc.getElementById("voice_mode_settings_drawer").children[0].children[1];
    doc.getElementById("vm_st_export_chat_btn").click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(badge.textContent, "没有可导出的回复。");
  } finally {
    await runtime.dispose();
  }
});


test("Export chat collects recent AI replies in order and reports a non-WAV engine", async () => {
  const chat = [
    { is_user: true, mes: "hello from the user" },
    { is_user: false, name: "Alice", mes: "First reply. Second sentence." },
    { is_user: false, name: "Alice", mes: "Third reply here." },
  ];
  const { doc, runtime } = createDrawerFixture({
    chat,
    translate: (fallback, key) => chineseCatalog[key] || fallback,
  });
  try {
    await runtime.activate();
    const badge = doc.getElementById("voice_mode_settings_drawer").children[0].children[1];
    doc.getElementById("vm_st_export_chat_btn").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Default engine is system: the multi-reply path must run (collect + segment) and then
    // report that system speech cannot produce WAV instead of crashing or hanging.
    assert.equal(
      badge.textContent,
      "当前 TTS 引擎无法导出 WAV；需要本地语音守护进程或支持 WAV 的引擎。",
    );
  } finally {
    await runtime.dispose();
  }
});

test("Export chat end-to-end through a mocked daemon reports the exported sentence count", async () => {
  const { encodeMonoPcm16Wav } = await import("@voice-mode/core");
  const wav = encodeMonoPcm16Wav(new Float32Array(2400).fill(0.1), 24000);
  const chat = [
    { is_user: true, mes: "hello from the user" },
    { is_user: false, name: "Alice", mes: "First reply. Second sentence." },
    { is_user: false, name: "Alice", mes: "Third reply here." },
  ];
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/health")) {
      return new Response(
        JSON.stringify({ ok: true, service: "voice-daemon", version: "0.1.0", capabilities: ["tts"], voices: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
  };
  const { doc, runtime } = createDrawerFixture({
    chat,
    defaultEngine: "kokoro-daemon",
    translate: (fallback, key) => chineseCatalog[key] || fallback,
  });
  try {
    await runtime.activate();
    const badge = doc.getElementById("voice_mode_settings_drawer").children[0].children[1];
    doc.getElementById("vm_st_export_chat_btn").click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !badge.textContent.includes("已导出")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(badge.textContent, "已导出 3 句为 WAV。");
  } finally {
    globalThis.fetch = baseFetch;
    await runtime.dispose();
  }
});
