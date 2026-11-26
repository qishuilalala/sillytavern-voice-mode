import assert from "node:assert/strict";
import test from "node:test";
import { ensureExtensionSettings } from "../src/settings.ts";
import { VoiceModeIoController } from "../src/voice-io.ts";

function webSpeech(startError) {
  const settings = ensureExtensionSettings({});
  const recognizers = [];
  const events = [];
  const input = { tagName: "TEXTAREA", value: "Typed draft", dispatchEvent: () => true };
  const send = { clicks: 0, click() { this.clicks++; } };
  const document = {
    documentElement: { lang: "zh-CN" },
    activeElement: input,
    getElementById: (id) => id === "send_textarea" ? input : send,
  };
  class Recognition {
    lang = "";
    constructor() { recognizers.push(this); }
    start() { if (startError) throw startError; }
    stop() {}
  }
  const io = new VoiceModeIoController({
    getSettings: () => settings,
    getSecret: async () => null,
    getWindow: () => ({
      isSecureContext: true,
      location: { protocol: "https:", hostname: "localhost" },
      navigator: { language: "zh-CN" },
      webkitSpeechRecognition: Recognition,
    }),
    getDocument: () => document,
    isGenerating: () => false,
    stopGeneration: () => false,
    cancelPlayback: () => {},
    onDictationStateChange: (state) => events.push(state),
    onError: (error) => events.push(error),
  });
  return { settings, recognizers, io, events, input, send };
}

test("automatic Web Speech language inherits the document default and explicit language wins", async (t) => {
  const { io, settings, recognizers } = webSpeech();
  t.after(() => io.dispose());
  assert.equal(settings.asrLanguage, "auto");
  assert.equal(await io.startDictation(), true);
  assert.equal(recognizers[0].lang, "");
  settings.asrLanguage = "yue-HK";
  assert.equal(await io.startDictation(), true);
  assert.equal(recognizers[1].lang, "yue-HK");

  recognizers[0].onend();
  assert.equal(io.activeDictationState, "listening");
  await io.stopDictation();
  recognizers[1].onend();
  assert.equal(io.activeDictationState, "idle");
});

test("permission denial followed by end retains actionable guidance and allows another attempt", async (t) => {
  const { io, recognizers, events, input } = webSpeech();
  t.after(() => io.dispose());
  await io.startDictation();
  recognizers[0].onerror({ error: "not-allowed" });
  recognizers[0].onend();
  assert.equal(io.activeDictationState, "idle");
  assert.equal(events.at(-1).name, "NotAllowedError");
  assert.match(events.at(-1).message, /microphone access.*site settings.*type/i);
  assert.equal(input.value, "Typed draft");

  assert.equal(await io.startDictation(), true);
  recognizers[0].onend();
  recognizers[0].onerror({ error: "service-not-allowed" });
  assert.equal(events.at(-1), "listening");
  recognizers[1].onerror({ error: "service-not-allowed" });
  recognizers[1].onend();
  assert.equal(events.at(-1).name, "ServiceNotAllowedError");
  assert.match(events.at(-1).message, /type/i);
});

test("quiet end events settle normally and synchronous permission failures release the microphone state", async (t) => {
  const { io, recognizers, events } = webSpeech();
  t.after(() => io.dispose());
  for (const code of ["no-speech", "aborted"]) {
    await io.startDictation();
    const rec = recognizers.at(-1);
    rec.onerror({ error: code });
    rec.onend();
    assert.equal(events.at(-1), "idle");
  }

  const denied = webSpeech(new DOMException("permission denied", "NotAllowedError"));
  t.after(() => denied.io.dispose());
  assert.equal(await denied.io.startDictation(), false);
  assert.equal(denied.io.activeDictationState, "idle");
  assert.equal(denied.events.at(-1).name, "NotAllowedError");
  assert.match(denied.events.at(-1).message, /site settings/i);
});

test("a stopped recognizer can deliver its final result until it ends, is replaced, or is disposed", async () => {
  const { io, settings, recognizers, input, send, events } = webSpeech();
  settings.autoSendOnDictation = true;
  const result = { results: [[{ transcript: "final" }]] };
  await io.startDictation();
  await io.stopDictation();
  const first = recognizers[0];
  first.onresult(result);
  assert.equal(input.value, "Typed draftfinal");
  assert.equal(send.clicks, 1);
  first.onend();
  first.onresult(result);
  assert.equal(send.clicks, 1);

  await io.startDictation();
  const old = recognizers[1];
  const replacement = io.startDictation();
  input.value = "New draft";
  old.onresult(result);
  await replacement;
  old.onresult(result);
  old.onerror({ error: "not-allowed" });
  old.onend();
  assert.equal(input.value, "New draft");
  assert.equal(send.clicks, 1);
  assert.equal(events.at(-1), "listening");

  await io.stopDictation();
  await io.dispose();
  recognizers[2].onresult(result);
  assert.equal(input.value, "New draft");
  assert.equal(send.clicks, 1);
});

test("disposing during microphone startup prevents a queued start from reopening it", async () => {
  const { io, recognizers, events } = webSpeech();
  const start = io.startDictation();
  await io.dispose();
  assert.equal(await start, false);
  assert.equal(recognizers.length, 0);
  assert.equal(events.includes("listening"), false);
});

test("semantic endpoint stops dictation early when interim text is a complete sentence (D-0023 A)", async (t) => {
  const { io, settings, recognizers, input } = webSpeech();
  t.after(() => io.dispose());
  settings.semanticEndpoint = true;
  assert.equal(await io.startDictation(), true);
  const rec = recognizers[0];
  let stopped = 0;
  rec.stop = () => {
    stopped += 1;
  };
  // Interim that is not yet a complete sentence must not stop.
  rec.onresult({ results: [{ isFinal: false, 0: { transcript: "今天天气" } }] });
  assert.equal(stopped, 0, "incomplete interim must not stop early");
  // Complete sentence with terminal punctuation stops early.
  rec.onresult({ results: [{ isFinal: false, 0: { transcript: "今天天气很好。" } }] });
  assert.equal(stopped, 1, "complete sentence must stop dictation early");
  // The browser's final transcript is injected exactly once.
  rec.onresult({ results: [{ isFinal: true, 0: { transcript: "今天天气很好。" } }] });
  assert.match(input.value, /今天天气很好/);
  rec.onend();
  assert.equal(io.activeDictationState, "idle");
});
