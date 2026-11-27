import {
  DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
  DaemonClient,
  MimoTtsEngine,
  OpenAiCompatTtsEngine,
  compileEmotionPlan,
  mergeMonoPcm16WavChunks,
  type TtsSynthResult,
} from "@voice-mode/core";
import {
  BrowserAudioSink,
  PlaybackQueue,
  SYSTEM_TTS_MIME,
  SystemTtsEngine,
  buildSystemTtsSegments,
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

export { BrowserAudioSink, SYSTEM_TTS_MIME, SystemTtsEngine, buildSystemTtsSegments } from "@voice-mode/browser";
export type { SystemTtsPayload, SystemTtsSegment } from "@voice-mode/browser";

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

/** Result of exporting chat utterances into a single WAV file (P4 parity). */
export interface TtsExportResult {
  wav: Uint8Array | null;
  sampleRate: number;
  sentences: number;
  skipped: number;
  reason?: "no-wav-engine" | "empty";
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

  /**
   * Synthesize utterances without playing and merge WAV-capable output into one file.
   * Non-WAV engines (system text / MP3 providers) are skipped and reported.
   */
  async exportUtterances(utterances: readonly RoutedUtterance[]): Promise<TtsExportResult> {
    const wavChunks: Uint8Array[] = [];
    let skipped = 0;
    const exportedKeys: string[] = [];
    for (const utterance of utterances) {
      const envelope = JSON.stringify(this.createEnvelope(utterance, this.options.getSettings()));
      exportedKeys.push(envelope);
      let result: TtsSynthResult | null = null;
      try {
        result = await this.synthesizeEnvelope(envelope, new AbortController().signal);
      } catch {
        skipped += 1;
        continue;
      }
      if (!result || result.mime !== "audio/wav") {
        skipped += 1;
        continue;
      }
      wavChunks.push(result.audio);
    }
    // Exporting must not leave playback bookkeeping behind.
    for (const key of exportedKeys) {
      this.pendingInfo.delete(key);
    }
    const merged = mergeMonoPcm16WavChunks(wavChunks);
    if (!merged) {
      return {
        wav: null,
        sampleRate: 0,
        sentences: 0,
        skipped: skipped + wavChunks.length,
        reason: "no-wav-engine",
      };
    }
    return {
      wav: merged.wav,
      sampleRate: merged.sampleRate,
      sentences: merged.merged,
      skipped: skipped + merged.skipped,
    };
  }

  enqueueUtterance(utterance: RoutedUtterance): boolean {
    const settings = this.options.getSettings();
    if (!settings.enabled) return false;
    const envelope = this.createEnvelope(utterance, settings);
    const resolved = resolveUtteranceVoice(utterance, settings, envelope.cardVoice);
    this.lastUsesSystemTts = resolved.engine === "system";
    return this.queue.enqueue(JSON.stringify(envelope));
  }

  private createEnvelope(
    utterance: RoutedUtterance,
    settings: VoiceModeExtensionSettings,
  ): QueuedEnvelope & { seq: number } {
    const cardVoiceRaw = this.options.getCharacterCardVoice?.(
      utterance.speaker,
      utterance.avatar,
    );
    const cardVoice =
      cardVoiceRaw && typeof cardVoiceRaw === "object"
        ? normalizeVoiceAssignment(cardVoiceRaw, settings.defaultVoice.engine)
        : undefined;
    return {
      seq: ++this.seq,
      role: utterance.role,
      speaker: utterance.speaker,
      ...(utterance.avatar ? { avatar: utterance.avatar } : {}),
      text: utterance.text,
      ...(cardVoice ? { cardVoice } : {}),
    };
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
