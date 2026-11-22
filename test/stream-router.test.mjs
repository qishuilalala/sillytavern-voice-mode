import assert from "node:assert/strict";
import test from "node:test";

import { StreamingUtteranceRouter } from "../src/stream-router.ts";

test("StreamingUtteranceRouter emits first sentence mid-stream from cumulative tokens and splits *narration* vs dialogue without breaking **bold**", () => {
  const emitted = [];
  const router = new StreamingUtteranceRouter({
    narrationSplitEnabled: true,
    onUtterance: (u) => emitted.push(u),
  });

  router.onGenerationStarted({
    type: "normal",
    dryRun: false,
    speaker: "Seraphina",
    avatar: "seraphina.png",
  });

  // Cumulative token stream (each call passes the FULL accumulated reply so far, matching SillyTavern 1.19.1)
  const cumulativeFrames = [
    "*The rain",
    "*The rain tapped against the window. ",
    "*The rain tapped against the window. She stepped closer.*",
    '*The rain tapped against the window. She stepped closer.* "You are **very**',
    '*The rain tapped against the window. She stepped closer.* "You are **very** brave! ',
    '*The rain tapped against the window. She stepped closer.* "You are **very** brave! <whisper>Stay quiet.</whisper>"',
  ];

  router.onStreamToken(cumulativeFrames[0]);
  assert.equal(emitted.length, 0);

  // Frame 1 completes sentence 1 inside *narration* BEFORE closing asterisk or GENERATION_ENDED!
  router.onStreamToken(cumulativeFrames[1]);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].role, "narrator");
  assert.equal(emitted[0].speaker, "Seraphina");
  assert.match(emitted[0].text, /The rain tapped against the window/);

  // Frame 2 closes *narration*, flushing sentence 2 as narrator
  router.onStreamToken(cumulativeFrames[2]);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].role, "narrator");
  assert.match(emitted[1].text, /She stepped closer/);

  // Frame 3 has **very** (bold, NOT narration toggle)
  router.onStreamToken(cumulativeFrames[3]);
  assert.equal(emitted.length, 2);

  // Frame 4 finishes first spoken dialogue sentence mid-stream as character
  router.onStreamToken(cumulativeFrames[4]);
  assert.equal(emitted.length, 3);
  assert.equal(emitted[2].role, "character");
  assert.match(emitted[2].text, /You are very brave/);

  // Frame 5 adds final emotion-tagged sentence; GENERATION_ENDED flushes tail
  router.onStreamToken(cumulativeFrames[5]);
  router.onGenerationEnded();
  assert.equal(emitted.length, 4);
  assert.equal(emitted[3].role, "character");
  assert.match(emitted[3].text, /<whisper>Stay quiet\.<\/whisper>/);

  // Subsequent CHARACTER_MESSAGE_RENDERED for the same streamed turn must NOT double-emit
  router.onCharacterMessageRendered({
    messageId: 1,
    type: "normal",
    message: {
      name: "Seraphina",
      is_user: false,
      mes: cumulativeFrames[5],
    },
  });
  assert.equal(emitted.length, 4);
});

test("StreamingUtteranceRouter ignores dryRun/quiet/impersonate and falls back cleanly on non-streamed CHARACTER_MESSAGE_RENDERED", () => {
  const emitted = [];
  const router = new StreamingUtteranceRouter({
    narrationSplitEnabled: true,
    onUtterance: (u) => emitted.push(u),
  });

  for (const [type, dryRun] of [
    ["normal", true],
    ["quiet", false],
    ["impersonate", false],
  ]) {
    router.onGenerationStarted({ type, dryRun, speaker: "Bob" });
    router.onStreamToken("Should never be spoken. Really never.");
    router.onGenerationEnded();
  }
  assert.equal(emitted.length, 0);

  // Non-streaming character message render
  router.onCharacterMessageRendered({
    messageId: 2,
    type: "normal",
    message: {
      name: "Bob",
      original_avatar: "bob.png",
      is_user: false,
      mes: '*He nods.* "Understood."',
    },
  });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].role, "narrator");
  assert.equal(emitted[0].avatar, "bob.png");
  assert.equal(emitted[1].role, "character");
  assert.match(emitted[1].text, /Understood/);
});

test("StreamingUtteranceRouter discards buffered tail immediately on GENERATION_STOPPED", () => {
  const emitted = [];
  const router = new StreamingUtteranceRouter({
    narrationSplitEnabled: false,
    onUtterance: (u) => emitted.push(u),
  });

  router.onGenerationStarted({ type: "normal", dryRun: false, speaker: "Alice" });
  router.onStreamToken("Unfinished sentence before barge-in");
  router.onGenerationStopped();
  router.onGenerationEnded();
  assert.equal(emitted.length, 0);
});

test("StreamingUtteranceRouter carries open <whisper> state across multi-sentence splits", () => {
  const emitted = [];
  const router = new StreamingUtteranceRouter({
    narrationSplitEnabled: true,
    onUtterance: (u) => emitted.push(u),
  });

  router.onGenerationStarted({ type: "normal", dryRun: false, speaker: "Lyra" });
  router.onStreamToken('"<whisper>Sentence one is hushed. ');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].text, "<whisper>Sentence one is hushed.</whisper>");

  router.onStreamToken(
    '"<whisper>Sentence one is hushed. Sentence two stays hushed.</whisper> Normal voice returns."',
  );
  router.onGenerationEnded();

  assert.equal(emitted.length, 3);
  assert.equal(emitted[1].text, "<whisper>Sentence two stays hushed.</whisper>");
  assert.equal(emitted[2].text, "Normal voice returns.");
});

test("a leading Markdown rule streams complete dialogue before the turn ends", () => {
  const router = new StreamingUtteranceRouter();
  router.onGenerationStarted({ speaker: "Alice" });
  const start = "---\n\n第一句。第二句。";
  const emitted = router.onStreamToken(start);
  assert.deepEqual(emitted.map((utterance) => utterance.text), ["第一句。", "第二句。"]);
  const rest = [
    ...router.onStreamToken(start + "\n---\n第三句。"),
    ...router.onGenerationEnded(),
  ];
  assert.deepEqual(rest.map((utterance) => utterance.text), ["第三句。"]);
});
