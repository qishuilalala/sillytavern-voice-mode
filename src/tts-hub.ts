import {
  DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
  DaemonClient,
  MimoTtsEngine,
  OpenAiCompatTtsEngine,
  compileEmotionPlan,
  type EmotionSegment,
  type TtsEngine,
  type TtsSynthOptions,
  type TtsSynthResult,
} from "@voice-mode/core";
import {
  PlaybackQueue,
  type AudioSink,
  type PlaybackQueueState,
} from "@voice-mode/browser";
import {
  normalizeVoiceAssignment,
  type SecretSlot,
  type StTtsEngineKind,
  type VoiceAssignment,
  type VoiceModeExtensionSettings,
} from "./settings.ts";
import type { RoutedUtterance, UtteranceRole } from "./stream-router.ts";

export const SYSTEM_TTS_MIME = "application/x-voice-mode-system-tts";

export interface SystemTtsSegment {
  text: string;
  whisper: boolean;
  preBreakMs: number;
  breakAfterMs: number;
}

export interface SystemTtsPayload {
  text: string;
  voice: string;
  rate: number;
  segments: SystemTtsSegment[];
}

export interface UtterancePlaybackInfo {
  role: UtteranceRole;
  speaker: string;
  avatar?: string;
  engine: StTtsEngineKind;
  voice: string;
  rawText: string;
  plainText: string;
  hasEmotionCues: boolean;
  startedAtMs: number;
}

interface QueuedEnvelope {
  role: UtteranceRole;
  speaker: string;
  avatar?: string;
  text: string;
  cardVoice?: VoiceAssignment;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function computeLeadingBreakMs(rawText: string): number {
  let sum = 0;
  let rest = rawText;
  const leadRe = /^\s*<\s*break\s+(\d+)\s*ms\s*>/i;
  while (true) {
    const m = leadRe.exec(rest);
    if (!m) break;
    sum += Math.min(5000, Math.max(0, Number(m[1] ?? 0)));
    rest = rest.slice(m[0].length);
  }
  return Math.min(10000, sum);
}

export function buildSystemTtsSegments(
  rawText: string,
  segments: readonly EmotionSegment[],
): SystemTtsSegment[] {
  if (segments.length === 0) return [];
  const leadingBreak = computeLeadingBreakMs(rawText);
  return segments.map((seg, idx) => {
    const attached = Math.max(0, Math.min(5000, seg.preBreakMs ?? 0));
    if (idx === 0 && leadingBreak > 0) {
      const pre = Math.min(leadingBreak, attached);
      return {
        text: seg.text,
        whisper: seg.whisper,
        preBreakMs: pre,
        breakAfterMs: Math.max(0, attached - pre),
      };
    }
    return {
      text: seg.text,
      whisper: seg.whisper,
      preBreakMs: 0,
      breakAfterMs: attached,
    };
  });
}

export class SystemTtsEngine implements TtsEngine {
  readonly kind = "system" as const;
  readonly mime = SYSTEM_TTS_MIME;
  private defaultVoice = "";
  private defaultRate = 1;

  updateVoice(voice: string, rate?: number): void {
    this.defaultVoice = voice;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      this.defaultRate = rate;
    }
  }

  async synthesize(
    text: string,
    options?: TtsSynthOptions & { segments?: SystemTtsSegment[] },
  ): Promise<TtsSynthResult> {
    const segments =
      options?.segments && options.segments.length > 0
        ? options.segments
        : [{ text, whisper: false, preBreakMs: 0, breakAfterMs: 0 }];
    const payload: SystemTtsPayload = {
      text,
      voice: options?.voice ?? this.defaultVoice,
      rate: options?.rate ?? this.defaultRate,
      segments,
    };
    return {
      audio: new TextEncoder().encode(JSON.stringify(payload)),
      mime: SYSTEM_TTS_MIME,
    };
  }

  interrupt(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore browser speechSynthesis cancellation errors.
      }
    }
  }

  async close(): Promise<void> {
    this.interrupt();
  }
}

export class BrowserAudioSink implements AudioSink {
  private sharedAudio: HTMLAudioElement | null = null;
  private activeObjectUrl: string | null = null;
  private audioPlaying = false;

  async play(payload: TtsSynthResult, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (payload.mime === SYSTEM_TTS_MIME) {
      await this.playSystemUtterance(payload.audio, signal);
      return;
    }
    await this.playAudioBytes(payload, signal);
  }

  pause(): void {
    if (this.audioPlaying && this.sharedAudio) {
      this.sharedAudio.pause();
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.pause();
    }
  }

  resume(): void {
    if (this.audioPlaying && this.sharedAudio) {
      void this.sharedAudio.play().catch(() => undefined);
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
    }
  }

  stop(): void {
    this.resetSharedAudio();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancellation errors.
      }
    }
  }

  private resetSharedAudio(): void {
    this.audioPlaying = false;
    if (this.sharedAudio) {
      try {
        this.sharedAudio.onended = null;
        this.sharedAudio.onerror = null;
        this.sharedAudio.pause();
        this.sharedAudio.removeAttribute("src");
        this.sharedAudio.load();
      } catch {
        // Ignore media element reset errors.
      }
    }
    if (this.activeObjectUrl && typeof URL !== "undefined") {
      try {
        URL.revokeObjectURL(this.activeObjectUrl);
      } catch {
        // Ignore revoke errors.
      }
      this.activeObjectUrl = null;
    }
  }

  private async speakSingleSystemSegment(
    text: string,
    voiceName: string,
    rate: number,
    whisper: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || !text.trim()) return;
    const synth =
      typeof window !== "undefined" && "speechSynthesis" in window
        ? window.speechSynthesis
        : null;
    const UtteranceCtor =
      typeof SpeechSynthesisUtterance !== "undefined"
        ? SpeechSynthesisUtterance
        : null;
    const voices = synth ? synth.getVoices() : [];

    if (!synth || !UtteranceCtor || voices.length === 0) {
      const durationMs = Math.min(900, Math.max(100, text.length * 16));
      await abortableDelay(durationMs, signal);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        try {
          synth.cancel();
        } catch {
          // Ignore cancellation errors.
        }
        finish();
      };

      const utterance = new UtteranceCtor(text);
      if (voiceName) {
        const matched = voices.find(
          (v) =>
            v.name === voiceName ||
            v.voiceURI === voiceName ||
            v.lang === voiceName,
        );
        if (matched) utterance.voice = matched;
      }
      utterance.rate = rate || 1;
      utterance.volume = whisper ? 0.65 : 1;
      utterance.onend = finish;
      utterance.onerror = finish;

      const maxExpectedMs = Math.min(20000, Math.max(2500, text.length * 120));
      const safetyTimer = setTimeout(finish, maxExpectedMs);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch {
        finish();
      }
    });
  }

  private async playSystemUtterance(
    encoded: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = JSON.parse(
      new TextDecoder().decode(encoded),
    ) as SystemTtsPayload;
    const segs =
      Array.isArray(parsed.segments) && parsed.segments.length > 0
        ? parsed.segments
        : [{ text: parsed.text, whisper: false, preBreakMs: 0, breakAfterMs: 0 }];

    for (const seg of segs) {
      if (signal.aborted) return;
      if (seg.preBreakMs > 0) {
        await abortableDelay(seg.preBreakMs, signal);
      }
      if (signal.aborted) return;
      await this.speakSingleSystemSegment(
        seg.text,
        parsed.voice,
        parsed.rate,
        seg.whisper,
        signal,
      );
      if (signal.aborted) return;
      if (seg.breakAfterMs > 0) {
        await abortableDelay(seg.breakAfterMs, signal);
      }
    }
  }

  private async playAudioBytes(
    payload: TtsSynthResult,
    signal: AbortSignal,
  ): Promise<void> {
    if (typeof Audio === "undefined" || typeof URL === "undefined") {
      await abortableDelay(80, signal);
      return;
    }
    this.resetSharedAudio();
    const copy = new Uint8Array(payload.audio.byteLength);
    copy.set(payload.audio);
    const blob = new Blob([copy], { type: payload.mime || "audio/wav" });
    const objectUrl = URL.createObjectURL(blob);
    const audio = (this.sharedAudio ??= new Audio());
    audio.src = objectUrl;
    this.activeObjectUrl = objectUrl;
    this.audioPlaying = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.resetSharedAudio();
        resolve();
      };
      const onAbort = () => {
        finish();
      };
      audio.onended = finish;
      audio.onerror = finish;
      signal.addEventListener("abort", onAbort, { once: true });
      void audio.play().catch(() => finish());
    });
  }
}

export interface VoiceModeTtsHubOptions {
  getSettings: () => VoiceModeExtensionSettings;
  getSecret: (slot: SecretSlot) => Promise<string | null>;
  getCharacterCardVoice?: (speaker: string, avatar?: string) => unknown;
  getRequestHeaders?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  sink?: AudioSink;
  onUtteranceStart?: (info: UtterancePlaybackInfo) => void;
  onStateChange?: (state: PlaybackQueueState) => void;
  onDaemonFallback?: (reason: string) => void;
  onError?: (error: unknown, text: string) => void;
}

export function resolveUtteranceVoice(
  utterance: RoutedUtterance,
  settings: VoiceModeExtensionSettings,
  cardVoiceRaw?: unknown,
): VoiceAssignment {
  if (utterance.role === "narrator" && settings.narrationSplitEnabled) {
    const narrator = settings.narratorVoice;
    if (narrator.voice || narrator.engine !== settings.defaultVoice.engine) {
      return narrator;
    }
    return settings.defaultVoice;
  }

  if (utterance.avatar && settings.voiceMap[utterance.avatar]) {
    return settings.voiceMap[utterance.avatar]!;
  }
  if (utterance.speaker && settings.voiceMap[utterance.speaker]) {
    return settings.voiceMap[utterance.speaker]!;
  }
  if (utterance.speaker) {
    const needle = utterance.speaker.toLowerCase();
    for (const [k, v] of Object.entries(settings.voiceMap)) {
      if (k.toLowerCase() === needle) return v;
    }
  }
  if (cardVoiceRaw && typeof cardVoiceRaw === "object") {
    return normalizeVoiceAssignment(cardVoiceRaw, settings.defaultVoice.engine);
  }
  return settings.defaultVoice;
}

const SERVER_PLUGIN_HEALTH_TTL_MS = 15_000;

export class VoiceModeTtsHub {
  private readonly options: VoiceModeTtsHubOptions;
  private readonly systemEngine = new SystemTtsEngine();
  private readonly sink: AudioSink;
  private readonly queue: PlaybackQueue;
  private daemonClient: DaemonClient | null = null;
  private daemonClientUrl = "";
  private serverPluginState: { available: boolean; expiresAt: number } | null = null;
  private readonly pendingInfo = new Map<string, UtterancePlaybackInfo>();
  private seq = 0;
  private lastUsesSystemTts = true;

  constructor(options: VoiceModeTtsHubOptions) {
    this.options = options;
    this.sink = options.sink ?? new BrowserAudioSink();
    this.queue = new PlaybackQueue({
      synthesize: (envelopeStr, signal) => this.synthesizeEnvelope(envelopeStr, signal),
      sink: this.sink,
      prefetchDepth: 2,
      onPlayStart: (envelopeStr) => {
        const info = this.pendingInfo.get(envelopeStr);
        this.pendingInfo.delete(envelopeStr);
        if (info) {
          info.startedAtMs = Date.now();
          this.lastUsesSystemTts = info.engine === "system";
          this.options.onUtteranceStart?.(info);
        }
      },
      onStateChange: (state) => {
        if (state === "idle") {
          this.pendingInfo.clear();
        }
        this.options.onStateChange?.(state);
      },
      onError: (err, envelopeStr) => {
        this.pendingInfo.delete(envelopeStr);
        this.options.onError?.(err, envelopeStr);
      },
    });
  }

  get state(): PlaybackQueueState {
    return this.queue.state;
  }

  get usesSystemTts(): boolean {
    const settings = this.options.getSettings();
    if (this.queue.state === "playing") {
      return this.lastUsesSystemTts;
    }
    return settings.defaultVoice.engine === "system";
  }

  enqueueUtterance(utterance: RoutedUtterance): boolean {
    const settings = this.options.getSettings();
    if (!settings.enabled) return false;
    const cardVoiceRaw = this.options.getCharacterCardVoice?.(
      utterance.speaker,
      utterance.avatar,
    );
    const cardVoice =
      cardVoiceRaw && typeof cardVoiceRaw === "object"
        ? normalizeVoiceAssignment(cardVoiceRaw, settings.defaultVoice.engine)
        : undefined;
    const resolved = resolveUtteranceVoice(utterance, settings, cardVoice);
    this.lastUsesSystemTts = resolved.engine === "system";

    const envelope: QueuedEnvelope & { seq: number } = {
      seq: ++this.seq,
      role: utterance.role,
      speaker: utterance.speaker,
      ...(utterance.avatar ? { avatar: utterance.avatar } : {}),
      text: utterance.text,
      ...(cardVoice ? { cardVoice } : {}),
    };
    return this.queue.enqueue(JSON.stringify(envelope));
  }

  cancel(): void {
    this.pendingInfo.clear();
    this.queue.cancel();
    this.sink.stop?.();
    this.daemonClient?.interruptTts();
  }

  waitUntilDrained(): Promise<void> {
    return this.queue.waitUntilDrained();
  }

  async dispose(): Promise<void> {
    this.pendingInfo.clear();
    this.queue.dispose();
    this.sink.stop?.();
    if (this.daemonClient) {
      await this.daemonClient.close();
      this.daemonClient = null;
    }
    await this.systemEngine.close();
  }

  private getBoundFetch(): typeof fetch {
    const custom = this.options.fetchImpl;
    if (custom) {
      return (input, init) => custom(input, init);
    }
    return (input, init) => globalThis.fetch(input, init);
  }

  private async isServerPluginHealthy(baseFetch: typeof fetch): Promise<boolean> {
    const now = Date.now();
    if (this.serverPluginState && now < this.serverPluginState.expiresAt) {
      return this.serverPluginState.available;
    }
    try {
      const res = await baseFetch("/api/plugins/voice-mode/health", {
        method: "GET",
        signal: AbortSignal.timeout(800),
      });
      if (!res.ok) {
        this.serverPluginState = {
          available: false,
          expiresAt: now + SERVER_PLUGIN_HEALTH_TTL_MS,
        };
        return false;
      }
      const data = (await res.json()) as { ok?: boolean; id?: string };
      const available = data?.ok === true && data?.id === "voice-mode";
      this.serverPluginState = {
        available,
        expiresAt: now + SERVER_PLUGIN_HEALTH_TTL_MS,
      };
      return available;
    } catch {
      this.serverPluginState = {
        available: false,
        expiresAt: now + SERVER_PLUGIN_HEALTH_TTL_MS,
      };
      return false;
    }
  }

  private getOrCreateDaemonClient(settings: VoiceModeExtensionSettings): DaemonClient {
    if (this.daemonClient && this.daemonClientUrl === settings.daemonBaseUrl) {
      return this.daemonClient;
    }
    this.daemonClient = new DaemonClient({
      baseUrl: settings.daemonBaseUrl,
      token: () => this.options.getSecret("daemon"),
      probeTimeoutMs: DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
      fallbackTts: this.systemEngine,
      onFallback: (surface, reason) => {
        if (surface === "tts") {
          this.options.onDaemonFallback?.(reason);
        }
      },
      fetchImpl: this.getBoundFetch(),
    });
    this.daemonClientUrl = settings.daemonBaseUrl;
    return this.daemonClient;
  }

  private buildFetchForByok(
    settings: VoiceModeExtensionSettings,
    slot: SecretSlot,
    presetId: string,
    customBaseUrl?: string,
  ): typeof fetch {
    const baseFetch = this.getBoundFetch();
    if (!settings.useServerPluginProxy) {
      return baseFetch;
    }
    return async (input, init) => {
      const pluginReady = await this.isServerPluginHealthy(baseFetch);
      if (!pluginReady) {
        return baseFetch(input, init);
      }
      const stHeaders = this.options.getRequestHeaders?.() ?? {
        "Content-Type": "application/json",
      };
      return baseFetch("/api/plugins/voice-mode/tts", {
        method: "POST",
        headers: stHeaders,
        body: JSON.stringify({
          presetId,
          ...(customBaseUrl ? { customBaseUrl } : {}),
          secretSlot: slot,
          upstreamBody: init?.body ? String(init.body) : "{}",
        }),
        signal: init?.signal,
      });
    };
  }

  private async synthesizeEnvelope(
    envelopeStr: string,
    signal: AbortSignal,
  ): Promise<TtsSynthResult | null> {
    const parsed = JSON.parse(envelopeStr) as QueuedEnvelope;
    const settings = this.options.getSettings();
    const assignment = resolveUtteranceVoice(
      parsed,
      settings,
      parsed.cardVoice,
    );

    const planMode =
      assignment.engine === "openai-compat" || assignment.engine === "mimo"
        ? "instructions"
        : "pcm-segments";
    const plan = compileEmotionPlan(parsed.text, planMode);
    if (!plan.plainText.trim()) {
      return null;
    }

    this.pendingInfo.set(envelopeStr, {
      role: parsed.role,
      speaker: parsed.speaker,
      ...(parsed.avatar ? { avatar: parsed.avatar } : {}),
      engine: assignment.engine,
      voice: assignment.voice,
      rawText: parsed.text,
      plainText: plan.plainText,
      hasEmotionCues: plan.hasEmotionCues,
      startedAtMs: 0,
    });

    if (assignment.engine === "system") {
      const sysSegments = buildSystemTtsSegments(parsed.text, plan.segments);
      return this.systemEngine.synthesize(plan.plainText, {
        voice: assignment.voice,
        rate: assignment.rate,
        signal,
        segments: sysSegments,
      });
    }

    if (assignment.engine === "kokoro-daemon") {
      const client = this.getOrCreateDaemonClient(settings);
      // Pass raw emotion-tagged text so voice-daemon compiles <whisper> and <break Nms> natively!
      const res = await client.synthesize(parsed.text, {
        voice: assignment.voice || undefined,
        rate: assignment.rate,
        signal,
      });
      if (res.mime === SYSTEM_TTS_MIME) {
        const info = this.pendingInfo.get(envelopeStr);
        if (info) info.engine = "system";
      }
      return res;
    }

    if (assignment.engine === "mimo") {
      const engine = new MimoTtsEngine({
        baseUrl: settings.mimoBaseUrl,
        model: settings.mimoModel,
        voice: assignment.voice || undefined,
        apiKey: () => this.options.getSecret("mimo"),
        instructions: plan.instructions || undefined,
        fallback: () => this.systemEngine,
        fetchImpl: this.buildFetchForByok(settings, "mimo", "mimo"),
      });
      return engine.synthesize(plan.plainText, {
        voice: assignment.voice || undefined,
        rate: assignment.rate,
        signal,
      });
    }

    const effectivePresetId = assignment.presetId ?? settings.openaiTtsPresetId;
    const engine = new OpenAiCompatTtsEngine({
      presetId: effectivePresetId,
      baseUrl: settings.openaiTtsBaseUrl,
      model: settings.openaiTtsModel,
      voice: assignment.voice || undefined,
      apiKey: () => this.options.getSecret("openaiTts"),
      instructions: plan.instructions || undefined,
      fallback: () => this.systemEngine,
      fetchImpl: this.buildFetchForByok(
        settings,
        "openaiTts",
        effectivePresetId,
        effectivePresetId === "custom" ? settings.openaiTtsBaseUrl : undefined,
      ),
    });
    return engine.synthesize(plan.plainText, {
      voice: assignment.voice || undefined,
      rate: assignment.rate,
      signal,
    });
  }
}
