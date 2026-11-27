import { SentenceSegmenter, type SegmenterOptions } from "@voice-mode/core";

export type UtteranceRole = "character" | "narrator";

export interface RoutedUtterance {
  role: UtteranceRole;
  speaker: string;
  avatar?: string;
  text: string;
}

export interface GenerationStartInput {
  type?: string;
  dryRun?: boolean;
  speaker?: string;
  avatar?: string;
}

export interface RenderedMessageInput {
  messageId: number;
  type?: string;
  message?: {
    name?: string;
    original_avatar?: string;
    is_user?: boolean;
    is_system?: boolean;
    mes?: string;
    extra?: Record<string, unknown>;
  } | null;
}

export function getRenderedMessageText(message: NonNullable<RenderedMessageInput["message"]>): string {
  const displayText = message.extra?.display_text;
  if (typeof displayText === "string" && displayText.trim()) return displayText;
  return typeof message.mes === "string" ? message.mes : "";
}

export interface StreamingUtteranceRouterOptions {
  narrationSplitEnabled?: boolean;
  segmenterOptions?: SegmenterOptions;
  resolveActiveSpeaker?: () => { speaker: string; avatar?: string };
  onUtterance?: (utterance: RoutedUtterance) => void;
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }
  return i;
}

function cleanOuterQuotes(text: string): string {
  return text.replace(/^["“”「」『』\s]+|["“”「」『』\s]+$/g, "").trim();
}

function splitTerminalWhisperBoundaries(raw: string): string[] {
  const out: string[] = [];
  const re = /([.!?。！？]["'”’)]?\s*<\s*\/whisper\s*>)\s+/gi;
  let last = 0;
  for (const m of raw.matchAll(re)) {
    const idx = m.index ?? 0;
    const endOfClose = idx + (m[1]?.length ?? 0);
    const head = raw.slice(last, endOfClose).trim();
    if (head) out.push(head);
    last = idx + m[0].length;
  }
  const tail = raw.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

export class StreamingUtteranceRouter {
  private narrationSplitEnabled: boolean;
  private readonly segmenterOptions?: SegmenterOptions;
  private readonly resolveActiveSpeaker?: () => { speaker: string; avatar?: string };
  private readonly onUtterance?: (utterance: RoutedUtterance) => void;
  private segmenter: SentenceSegmenter;

  private armed = false;
  private ignoredTurn = false;
  private streamSawTokens = false;
  private handledLastGenerationByStream = false;
  // Set when a generation is interrupted: the host may still render the truncated
  // message, and re-ingesting it would replay cancelled text. Deliberately not
  // cleared by reset(); cleared by the next onGenerationStarted/onChatChanged.
  private suppressNextRendered = false;
  private prevCumulativeText = "";
  private activeSpeaker = "";
  private activeAvatar: string | undefined = undefined;
  private inNarration = false;
  private pendingStar = false;
  private inOpenWhisper = false;

  constructor(options: StreamingUtteranceRouterOptions = {}) {
    this.narrationSplitEnabled = options.narrationSplitEnabled ?? true;
    this.segmenterOptions = options.segmenterOptions;
    this.resolveActiveSpeaker = options.resolveActiveSpeaker;
    this.onUtterance = options.onUtterance;
    this.segmenter = new SentenceSegmenter(this.segmenterOptions);
  }

  setNarrationSplitEnabled(enabled: boolean): void {
    this.narrationSplitEnabled = enabled;
  }

  onGenerationStarted(input: GenerationStartInput = {}): void {
    this.suppressNextRendered = false;
    const type = input.type ?? "normal";
    if (input.dryRun === true || type === "quiet" || type === "impersonate") {
      this.reset();
      this.ignoredTurn = true;
      return;
    }
    this.reset();
    const fallback = this.resolveActiveSpeaker?.();
    this.activeSpeaker = input.speaker ?? fallback?.speaker ?? "";
    this.activeAvatar = input.avatar ?? fallback?.avatar;
    this.armed = true;
  }

  onStreamToken(cumulativeText: string): RoutedUtterance[] {
    if (this.ignoredTurn || typeof cumulativeText !== "string" || !cumulativeText) {
      return [];
    }
    if (!this.armed) {
      const fallback = this.resolveActiveSpeaker?.();
      this.activeSpeaker = fallback?.speaker ?? "";
      this.activeAvatar = fallback?.avatar;
      this.armed = true;
    }

    this.streamSawTokens = true;
    let delta: string;
    if (cumulativeText.startsWith(this.prevCumulativeText)) {
      delta = cumulativeText.slice(this.prevCumulativeText.length);
    } else {
      const prefix = commonPrefixLength(this.prevCumulativeText, cumulativeText);
      delta = cumulativeText.slice(prefix);
    }
    this.prevCumulativeText = cumulativeText;
    if (!delta) return [];

    return this.ingestDelta(delta, this.activeSpeaker, this.activeAvatar);
  }

  onGenerationEnded(): RoutedUtterance[] {
    if (this.ignoredTurn) {
      this.ignoredTurn = false;
      this.armed = false;
      return [];
    }
    if (!this.armed || !this.streamSawTokens) {
      this.armed = false;
      return [];
    }
    const tail = this.flushActive(this.activeSpeaker, this.activeAvatar);
    this.armed = false;
    this.handledLastGenerationByStream = true;
    return tail;
  }

  onGenerationStopped(): void {
    this.reset();
    this.suppressNextRendered = true;
  }

  onChatChanged(): void {
    this.reset();
    this.suppressNextRendered = false;
  }

  onCharacterMessageRendered(input: RenderedMessageInput): RoutedUtterance[] {
    if (this.suppressNextRendered) {
      this.suppressNextRendered = false;
      return [];
    }
    if (input.type === "impersonate" || input.type === "quiet") {
      return [];
    }
    const msg = input.message;
    if (!msg || msg.is_user || msg.is_system) {
      return [];
    }
    if (this.handledLastGenerationByStream) {
      this.handledLastGenerationByStream = false;
      return [];
    }
    if (this.armed && this.streamSawTokens) {
      const tail = this.flushActive(
        msg.name ?? this.activeSpeaker,
        msg.original_avatar ?? this.activeAvatar,
      );
      this.armed = false;
      this.handledLastGenerationByStream = true;
      return tail;
    }

    const displayText = getRenderedMessageText(msg);
    if (!displayText.trim()) return [];

    this.reset();
    const speaker = msg.name ?? this.resolveActiveSpeaker?.().speaker ?? "";
    const avatar = msg.original_avatar ?? this.resolveActiveSpeaker?.().avatar;
    const out = [
      ...this.ingestDelta(displayText, speaker, avatar),
      ...this.flushActive(speaker, avatar),
    ];
    this.reset();
    return out;
  }

  reset(): void {
    this.armed = false;
    this.ignoredTurn = false;
    this.streamSawTokens = false;
    this.handledLastGenerationByStream = false;
    this.prevCumulativeText = "";
    this.activeSpeaker = "";
    this.activeAvatar = undefined;
    this.inNarration = false;
    this.pendingStar = false;
    this.inOpenWhisper = false;
    this.segmenter.flush();
  }

  private balanceSentenceWhisper(raw: string): string {
    const seeded = this.inOpenWhisper ? `<whisper>${raw}` : raw;
    let depth = 0;
    let rebuilt = "";
    let lastIdx = 0;
    const tagRe = /<\s*(\/?)\s*whisper\s*>/gi;
    for (const match of seeded.matchAll(tagRe)) {
      const idx = match.index ?? 0;
      rebuilt += seeded.slice(lastIdx, idx);
      lastIdx = idx + match[0].length;
      const isClosing = match[1] === "/";
      if (!isClosing) {
        if (depth === 0) rebuilt += "<whisper>";
        depth++;
      } else if (depth > 0) {
        depth--;
        if (depth === 0) rebuilt += "</whisper>";
      }
    }
    rebuilt += seeded.slice(lastIdx);
    if (depth > 0) {
      rebuilt += "</whisper>";
      this.inOpenWhisper = true;
    } else {
      this.inOpenWhisper = false;
    }
    const collapsed = rebuilt.replace(/<\s*whisper\s*>\s*<\s*\/whisper\s*>/gi, "").trim();
    const textWithoutWhisper = collapsed.replace(/<\s*\/?\s*whisper\s*>/gi, "").trim();
    return textWithoutWhisper ? collapsed : "";
  }

  private currentRole(): UtteranceRole {
    return this.narrationSplitEnabled && this.inNarration ? "narrator" : "character";
  }

  private emitSentences(
    sentences: string[],
    role: UtteranceRole,
    speaker: string,
    avatar: string | undefined,
    out: RoutedUtterance[],
  ): void {
    for (const rawSentence of sentences) {
      for (const raw of splitTerminalWhisperBoundaries(rawSentence)) {
        const preCleaned = role === "character" ? cleanOuterQuotes(raw) : raw.trim();
        const cleaned = this.balanceSentenceWhisper(preCleaned);
        if (!cleaned) continue;
        const utterance: RoutedUtterance = {
          role,
          speaker,
          ...(avatar ? { avatar } : {}),
          text: cleaned,
        };
        out.push(utterance);
        this.onUtterance?.(utterance);
      }
    }
  }

  private ingestDelta(
    delta: string,
    speaker: string,
    avatar: string | undefined,
  ): RoutedUtterance[] {
    const out: RoutedUtterance[] = [];
    if (!this.narrationSplitEnabled) {
      this.emitSentences(this.segmenter.feed(delta), "character", speaker, avatar, out);
      return out;
    }

    const work = this.pendingStar ? `*${delta}` : delta;
    this.pendingStar = false;

    let buf = "";
    let i = 0;
    while (i < work.length) {
      if (work[i] === "*") {
        // Hold trailing single asterisk to disambiguate `*narration*` vs `**bold**` on next token.
        if (i === work.length - 1) {
          if (buf) {
            this.emitSentences(
              this.segmenter.feed(buf),
              this.currentRole(),
              speaker,
              avatar,
              out,
            );
            buf = "";
          }
          this.pendingStar = true;
          i++;
          continue;
        }
        // Pass through multi-asterisk runs (`**bold**`, `***`) without toggling narration role.
        if (work[i + 1] === "*") {
          let runEnd = i + 2;
          while (runEnd < work.length && work[runEnd] === "*") {
            runEnd++;
          }
          buf += work.slice(i, runEnd);
          i = runEnd;
          continue;
        }

        // Confirmed single asterisk: flush current role span before toggling narrator <-> character.
        const roleBefore = this.currentRole();
        if (buf) {
          this.emitSentences(this.segmenter.feed(buf), roleBefore, speaker, avatar, out);
          buf = "";
        }
        this.emitSentences(this.segmenter.flush(), roleBefore, speaker, avatar, out);
        this.inOpenWhisper = false;
        this.inNarration = !this.inNarration;
        i++;
        continue;
      }
      buf += work[i];
      i++;
    }

    if (buf) {
      this.emitSentences(
        this.segmenter.feed(buf),
        this.currentRole(),
        speaker,
        avatar,
        out,
      );
    }
    return out;
  }

  private flushActive(speaker: string, avatar: string | undefined): RoutedUtterance[] {
    const out: RoutedUtterance[] = [];
    const role = this.currentRole();
    if (this.pendingStar) {
      this.pendingStar = false;
      this.emitSentences(this.segmenter.flush(), role, speaker, avatar, out);
      this.inNarration = false;
      return out;
    }
    this.emitSentences(this.segmenter.flush(), role, speaker, avatar, out);
    this.inNarration = false;
    this.inOpenWhisper = false;
    return out;
  }
}
