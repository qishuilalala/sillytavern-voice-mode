import {
  DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
  DaemonClient,
  MimoTtsEngine,
  OpenAiCompatTtsEngine,
  compileEmotionPlan,
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

export interface SystemTtsPayload {
  text: string;
  voice: string;
  rate: number;
  preBreakMs: number;
  whisper: boolean;
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
    options?: TtsSynthOptions & { preBreakMs?: number; whisper?: boolean },
  ): Promise<TtsSynthResult> {
    const payload: SystemTtsPayload = {
      text,
      voice: options?.voice ?? this.defaultVoice,
      rate: options?.rate ?? this.defaultRate,
      preBreakMs: Math.max(0, Math.min(3000, options?.preBreakMs ?? 0)),
      whisper: Boolean(options?.whisper),
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
  private activeAudio: HTMLAudioElement | null = null;
  private activeObjectUrl: string | null = null;

  async play(payload: TtsSynthResult, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (payload.mime === SYSTEM_TTS_MIME) {
      await this.playSystemUtterance(payload.audio, signal);
      return;
    }
    await this.playAudioBytes(payload, signal);
  }

  pause(): void {
    if (this.activeAudio) {
      this.activeAudio.pause();
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.pause();
    }
  }

  resume(): void {
    if (this.activeAudio) {
      void this.activeAudio.play().catch(() => undefined);
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
    }
  }

  stop(): void {
    this.cleanupAudioElement();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancellation errors.
      }
    }
  }

  private cleanupAudioElement(): void {
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.removeAttribute("src");
        this.activeAudio.load();
      } catch {
        // Ignore media element teardown errors.
      }
      this.activeAudio = null;
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

  private async playSystemUtterance(
    encoded: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = JSON.parse(
      new TextDecoder().decode(encoded),
    ) as SystemTtsPayload;
    if (parsed.preBreakMs > 0) {
      await abortableDelay(parsed.preBreakMs, signal);
    }
    if (signal.aborted || !parsed.text.trim()) return;

    const synth =
      typeof window !== "undefined" && "speechSynthesis" in window
        ? window.speechSynthesis
        : null;
    const UtteranceCtor =
      typeof SpeechSynthesisUtterance !== "undefined"
        ? SpeechSynthesisUtterance
        : null;
    const voices = synth ? synth.getVoices() : [];

    // Headless Chromium (`--headless=new`) often exposes zero OS speechSynthesis voices;
    // simulate bounded speaking time so queue events and barge-in remain deterministic.
    if (!synth || !UtteranceCtor || voices.length === 0) {
      const durationMs = Math.min(900, Math.max(140, parsed.text.length * 16));
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

      const utterance = new UtteranceCtor(parsed.text);
      if (parsed.voice) {
        const matched = voices.find(
          (v) =>
            v.name === parsed.voice ||
            v.voiceURI === parsed.voice ||
            v.lang === parsed.voice,
        );
        if (matched) utterance.voice = matched;
      }
      utterance.rate = parsed.rate || 1;
      utterance.volume = parsed.whisper ? 0.65 : 1;
      utterance.onend = finish;
      utterance.onerror = finish;

      const maxExpectedMs = Math.min(20000, Math.max(2500, parsed.text.length * 120));
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

  private async playAudioBytes(
    payload: TtsSynthResult,
    signal: AbortSignal,
  ): Promise<void> {
    if (typeof Audio === "undefined" || typeof URL === "undefined") {
      await abortableDelay(80, signal);
      return;
    }
    this.cleanupAudioElement();
    const copy = new Uint8Array(payload.audio.byteLength);
    copy.set(payload.audio);
    const blob = new Blob([copy], { type: payload.mime || "audio/wav" });
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    this.activeObjectUrl = objectUrl;
    this.activeAudio = audio;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.cleanupAudioElement();
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

export class VoiceModeTtsHub {
  private readonly options: VoiceModeTtsHubOptions;
  private readonly systemEngine = new SystemTtsEngine();
  private readonly sink: AudioSink;
  private readonly queue: PlaybackQueue;
  private daemonClient: DaemonClient | null = null;
  private daemonClientUrl = "";
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
  ): typeof fetch {
    const baseFetch = this.getBoundFetch();
    if (!settings.useServerPluginProxy) {
      return baseFetch;
    }
    return async (input, init) => {
      const targetUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const stHeaders = this.options.getRequestHeaders?.() ?? {
        "Content-Type": "application/json",
      };
      return baseFetch("/api/plugins/voice-mode/tts", {
        method: "POST",
        headers: stHeaders,
        body: JSON.stringify({
          targetUrl,
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

    const totalBreakMs = plan.segments.reduce(
      (sum, seg) => sum + (seg.preBreakMs ?? 0),
      0,
    );
    const isWhisper =
      plan.segments.length > 0 && plan.segments.every((seg) => seg.whisper);

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
      return this.systemEngine.synthesize(plan.plainText, {
        voice: assignment.voice,
        rate: assignment.rate,
        signal,
        preBreakMs: totalBreakMs,
        whisper: isWhisper,
      });
    }

    if (assignment.engine === "kokoro-daemon") {
      const client = this.getOrCreateDaemonClient(settings);
      const effectiveRate = isWhisper
        ? (assignment.rate ?? 1) * 0.92
        : assignment.rate;
      const res = await client.synthesize(plan.plainText, {
        voice: assignment.voice || undefined,
        rate: effectiveRate,
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
        fetchImpl: this.buildFetchForByok(settings, "mimo"),
      });
      return engine.synthesize(plan.plainText, {
        voice: assignment.voice || undefined,
        rate: assignment.rate,
        signal,
      });
    }

    const engine = new OpenAiCompatTtsEngine({
      presetId: assignment.presetId ?? settings.openaiTtsPresetId,
      baseUrl: settings.openaiTtsBaseUrl,
      model: settings.openaiTtsModel,
      voice: assignment.voice || undefined,
      apiKey: () => this.options.getSecret("openaiTts"),
      instructions: plan.instructions || undefined,
      fallback: () => this.systemEngine,
      fetchImpl: this.buildFetchForByok(settings, "openaiTts"),
    });
    return engine.synthesize(plan.plainText, {
      voice: assignment.voice || undefined,
      rate: assignment.rate,
      signal,
    });
  }
}
