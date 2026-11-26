import {
  DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
  DaemonClient,
  OpenAiCompatAsrTransport,
  createAsrReplacer,
} from "@voice-mode/core";
import {
  AecBargeInMonitor,
  CloudDictationSession,
  DuplexProtocol,
  FocusTextInjector,
  SherpaWorkerClient,
  computeChunkRms,
  isWorkerRequest,
  type AudioCaptureFactory,
  type BargeInCaptureFactory,
  type BargeInEvent,
  type BargeInStartResult,
  type DictationSessionState,
  type DuplexState,
  type WorkerLike,
  type WorkerResponse,
} from "@voice-mode/browser";
import {
  inspectSecureOrigin,
  type SecretSlot,
  type SecureOriginStatus,
  type VoiceModeExtensionSettings,
  type WindowOriginLike,
} from "./settings.ts";

/** Sentence-final markers for semantic endpointing on interim transcripts. */
const SEMANTIC_END_RE = /[。！？!?.…]\s*$/;

/** Whether interim text looks complete enough to end dictation early (D-0023 A, partial hosts). */
export function isSemanticEndpoint(text: string): boolean {
  const trimmed = String(text).trim();
  return trimmed.length >= 4 && SEMANTIC_END_RE.test(trimmed);
}

/** Minimum sustained speech chunks for non-WASM energy+spectral VAD (`5 * 64 ms = 320 ms < 600 ms`). */
export const ENERGY_VAD_CONFIRM_CHUNKS = 5;

function computeZeroCrossingRate(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1]! >= 0 && samples[i]! < 0) || (samples[i - 1]! < 0 && samples[i]! >= 0)) {
      crossings++;
    }
  }
  return crossings / (samples.length - 1);
}

function computeCrestFactor(samples: Float32Array, rms: number): number {
  if (rms <= 0 || samples.length === 0) return Infinity;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs > peak) peak = abs;
  }
  return peak / rms;
}

/**
 * Lightweight zero-WASM in-memory VAD Worker implementing the `@voice-mode/browser`
 * `WorkerLike` contract so `SherpaWorkerClient` + `AecBargeInMonitor` operate out of
 * the box in SillyTavern Git installs without downloading ONNX/WASM bundles.
 */
export function createEnergyVadWorkerClient(
  minSpeechRms = 0.015,
): SherpaWorkerClient {
  return new SherpaWorkerClient({
    createWorkerSource: () => "/* voice-mode energy+zcr+crest vad */",
    loadModelBinaries: async () => [],
    idleUnloadMs: 0,
    workerFactory: () => {
      let terminated = false;
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(raw) {
          if (terminated || !isWorkerRequest(raw)) return;
          const respond = (res: WorkerResponse) => {
            queueMicrotask(() => {
              if (!terminated) {
                worker.onmessage?.({ data: res });
              }
            });
          };
          if (raw.type === "model:load") {
            respond({
              id: raw.id,
              type: "model:loaded",
              target: raw.target,
              elapsedMs: 0,
            });
            return;
          }
          if (raw.type === "vad:process") {
            const pcm = new Float32Array(raw.pcm);
            const rms = computeChunkRms(pcm);
            const zcr = computeZeroCrossingRate(pcm);
            const crest = computeCrestFactor(pcm, rms);
            // Reject DC hum, high-freq hiss, and impulsive speaker clicks (crest > 10)
            const plausibleBand = zcr >= 0.008 && zcr <= 0.42 && crest <= 10;
            const isSpeech = rms >= minSpeechRms && plausibleBand;
            const speechProbability = isSpeech
              ? Math.min(0.99, 0.55 + rms * 2)
              : Math.min(0.4, rms * 8);
            respond({
              id: raw.id,
              type: "vad:result",
              speechProbability,
              isSpeech,
              speechEnded: false,
            });
            return;
          }
          respond({ id: raw.id, type: "worker:ack" });
        },
        terminate() {
          terminated = true;
        },
      };
      return { worker };
    },
  });
}

interface BrowserSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function webSpeechError(code: string, fallback?: unknown): unknown {
  if (code === "not-allowed" || code === "NotAllowedError") {
    return new DOMException(
      "Microphone access was denied. Allow microphone access in the site settings and try again, or type your message.",
      "NotAllowedError",
    );
  }
  if (code === "service-not-allowed") {
    return new DOMException(
      "The browser denied access to its speech recognition service. Select another ASR engine or type your message.",
      "ServiceNotAllowedError",
    );
  }
  return fallback ?? new Error(`SpeechRecognition error: ${code}`);
}

export interface VoiceModeIoControllerOptions {
  getSettings: () => VoiceModeExtensionSettings;
  getSecret: (slot: SecretSlot) => Promise<string | null>;
  getWindow: () => (WindowOriginLike & Record<string, unknown>) | null;
  getDocument: () => Document | null;
  isGenerating: () => boolean;
  stopGeneration: () => boolean;
  cancelPlayback: () => void;
  fetchImpl?: typeof fetch;
  sileroWorkerClient?: SherpaWorkerClient;
  bargeInCaptureAudio?: BargeInCaptureFactory;
  dictationCaptureAudio?: AudioCaptureFactory;
  onBargeInTriggered?: (source: "aec3" | "manual", event?: BargeInEvent) => void;
  onInsecureOrigin?: (status: SecureOriginStatus) => void;
  onDictationStateChange?: (state: DictationSessionState) => void;
  onError?: (err: unknown) => void;
}

export class VoiceModeIoController {
  private readonly options: VoiceModeIoControllerOptions;
  private readonly vadWorkerClient: SherpaWorkerClient;
  private readonly monitor: AecBargeInMonitor;
  private readonly focusInjector = new FocusTextInjector();
  /** Shared duplex state machine (P3): playback/interrupt bookkeeping stays uniform. */
  private readonly duplex = new DuplexProtocol({ duckOnOverlap: false });
  private cloudSession: CloudDictationSession | null = null;
  private daemonAsrClient: DaemonClient | null = null;
  private systemRecognition: BrowserSpeechRecognitionLike | null = null;
  private dictationGeneration = 0;
  private dictationState: DictationSessionState = "idle";
  private bargeInCount = 0;

  private readonly ownsVadWorker: boolean;

  constructor(options: VoiceModeIoControllerOptions) {
    this.options = options;
    this.ownsVadWorker = !options.sileroWorkerClient;
    this.vadWorkerClient = options.sileroWorkerClient ?? createEnergyVadWorkerClient();
    const win = options.getWindow();
    const ua =
      win && typeof (win.navigator as { userAgent?: string } | undefined)?.userAgent === "string"
        ? (win.navigator as { userAgent: string }).userAgent
        : "";
    const isEdge = /\bEdg\//.test(ua);
    const isSafari =
      /\bSafari\//.test(ua) &&
      !/(?:Chrome|Chromium|HeadlessChrome|CriOS|Edg)\//.test(ua);
    const isMobile = /\bAndroid\b|\biPhone\b|\biPad\b/i.test(ua);

    this.monitor = new AecBargeInMonitor({
      workerClient: this.vadWorkerClient,
      captureAudio: options.bargeInCaptureAudio,
      confirmChunks: options.sileroWorkerClient ? 2 : ENERGY_VAD_CONFIRM_CHUNKS,
      isEdge,
      isSafari,
      isMobile,
      onBargeIn: (ev) => {
        this.triggerBargeIn("aec3", ev);
      },
      onError: (err) => {
        this.options.onError?.(err);
      },
    });
  }

  get totalBargeIns(): number {
    return this.bargeInCount;
  }

  get activeDictationState(): DictationSessionState {
    return this.dictationState;
  }

  checkSecureOrigin(): SecureOriginStatus {
    return inspectSecureOrigin(this.options.getWindow());
  }

  /**
   * Immediately cancel TTS audio queue AND abort active SillyTavern LLM generation
   * (strictly guarded by `isGenerating()` so idle controllers never emit spurious stops).
   */
  triggerBargeIn(source: "aec3" | "manual" = "manual", event?: BargeInEvent): void {
    this.bargeInCount++;
    const transition = this.duplex.feed({ type: "barge-in" });
    const actions = new Set(transition.actions);
    void this.monitor.stop();
    if (actions.has("stop-playback")) {
      this.options.cancelPlayback();
    }
    if (actions.has("cancel-generation") && this.options.isGenerating()) {
      this.options.stopGeneration();
    }
    this.options.onBargeInTriggered?.(source, event);
  }

  async armBargeIn(overrides?: { usesSystemTts?: boolean }): Promise<BargeInStartResult> {
    const settings = this.options.getSettings();
    const originStatus = this.checkSecureOrigin();
    if (!originStatus.secure) {
      this.options.onInsecureOrigin?.(originStatus);
      return {
        activePolicy: "manual",
        reason: "native-aec-inactive",
        aecProbe: null,
      };
    }
    const started = await this.monitor.start({
      bargeInMode: settings.bargeInMode,
      usesSystemTts: overrides?.usesSystemTts ?? settings.defaultVoice.engine === "system",
    });
    if (started.activePolicy === "auto") {
      this.duplex.feed({ type: "playback-start" });
    }
    return started;
  }

  async disarmBargeIn(): Promise<void> {
    await this.monitor.stop();
    this.duplex.feed({ type: "playback-end" });
  }

  /** Current duplex state (idle/listening/overlap/speaking/barge-in) for diagnostics. */
  get duplexState(): DuplexState {
    return this.duplex.snapshot().state;
  }

  injectDictatedText(rawText: string): string {
    const settings = this.options.getSettings();
    const replacer = createAsrReplacer(settings.asrReplacements);
    const transformed = replacer(rawText).trim();
    if (!transformed) return "";

    const doc = this.options.getDocument();
    if (!doc) return transformed;

    const sendTextarea = doc.getElementById("send_textarea") as HTMLTextAreaElement | null;
    if (sendTextarea && doc.activeElement !== sendTextarea) {
      sendTextarea.focus();
    }

    this.focusInjector.inject(doc, transformed);

    if (settings.autoSendOnDictation) {
      const sendBtn = doc.getElementById("send_but") as HTMLElement | null;
      sendBtn?.click();
    }
    return transformed;
  }

  async startDictation(): Promise<boolean> {
    const originStatus = this.checkSecureOrigin();
    if (!originStatus.secure) {
      this.options.onInsecureOrigin?.(originStatus);
      return false;
    }

    const generation = ++this.dictationGeneration;
    await this.stopDictation();
    if (generation !== this.dictationGeneration) return false;
    this.triggerBargeIn("manual");

    const settings = this.options.getSettings();
    if (settings.asrEngine === "system") {
      return this.startBrowserSpeechRecognition(settings, generation);
    }

    const boundFetch: typeof fetch = this.options.fetchImpl
      ? (input, init) => this.options.fetchImpl!(input, init)
      : (input, init) => globalThis.fetch(input, init);

    const openaiAsr = new OpenAiCompatAsrTransport({
      baseUrl: settings.asrBaseUrl,
      model: settings.asrModel,
      language: settings.asrLanguage,
      apiKey: () => this.options.getSecret("asr"),
      fetchImpl: boundFetch,
    });

    const transport =
      settings.asrEngine === "daemon"
        ? (this.daemonAsrClient = new DaemonClient({
            baseUrl: settings.daemonBaseUrl,
            token: () => this.options.getSecret("daemon"),
            probeTimeoutMs: DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
            language: settings.asrLanguage,
            fallbackAsr: openaiAsr,
            fetchImpl: boundFetch,
          })).asr
        : openaiAsr;

    this.cloudSession = new CloudDictationSession({
      transport,
      captureAudio: this.options.dictationCaptureAudio,
      language: settings.asrLanguage,
      onStateChange: (state) => this.setDictationState(state),
      onFinalTranscript: (text) => {
        this.injectDictatedText(text);
      },
      onError: (err) => this.options.onError?.(err),
    });

    await this.cloudSession.start("single");
    return true;
  }

  async stopDictation(): Promise<void> {
    const recognition = this.systemRecognition;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Ignore browser SpeechRecognition stop errors.
      }
      if (this.systemRecognition === recognition) {
        this.systemRecognition = null;
        this.setDictationState("idle");
      }
    }
    if (this.cloudSession) {
      await this.cloudSession.stop();
      this.cloudSession = null;
    }
    if (this.daemonAsrClient) {
      await this.daemonAsrClient.close();
      this.daemonAsrClient = null;
    }
  }

  async dispose(): Promise<void> {
    ++this.dictationGeneration;
    await this.stopDictation();
    await this.monitor.stop();
    if (this.ownsVadWorker) {
      await this.vadWorkerClient.dispose();
    }
  }

  private setDictationState(state: DictationSessionState): void {
    this.dictationState = state;
    this.options.onDictationStateChange?.(state);
  }

  private startBrowserSpeechRecognition(
    settings: VoiceModeExtensionSettings,
    generation: number,
  ): boolean {
    const win = this.options.getWindow();
    const Ctor = (win?.SpeechRecognition ?? win?.webkitSpeechRecognition) as
      | (new () => BrowserSpeechRecognitionLike)
      | undefined;
    if (typeof Ctor !== "function") {
      this.options.onError?.(
        new DOMException(
          "Browser SpeechRecognition is unavailable; select OpenAI-Compatible or Local Voice Daemon ASR.",
          "NotSupportedError",
        ),
      );
      return false;
    }

    const rec = new Ctor();
    // An unset lang lets Web Speech inherit the document or browser language.
    if (settings.asrLanguage && settings.asrLanguage !== "auto") {
      rec.lang = settings.asrLanguage;
    }
    rec.continuous = false;
    // Interim results are only needed for semantic endpointing on partial hosts.
    rec.interimResults = settings.semanticEndpoint;
    rec.onresult = (ev) => {
      // stop() may still deliver a final transcript before end; replacing the session revokes it.
      if (generation !== this.dictationGeneration) return;
      const finals: string[] = [];
      let interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        const top = res[0];
        const transcript = top?.transcript ?? "";
        if (!transcript) continue;
        if (res.isFinal !== false) {
          finals.push(transcript);
        } else {
          interim += transcript;
        }
      }
      const finalText = finals.join(" ").trim();
      if (finalText) {
        this.injectDictatedText(finalText);
        return;
      }
      if (settings.semanticEndpoint && interim && isSemanticEndpoint(interim)) {
        // The browser delivers the final transcript after stop(); inject once there.
        try {
          rec.stop();
        } catch {
          // ignore stop errors
        }
      }
    };
    const finish = (error?: unknown): void => {
      if (generation !== this.dictationGeneration) return;
      ++this.dictationGeneration;
      if (this.systemRecognition !== rec) return;
      this.systemRecognition = null;
      this.setDictationState("idle");
      if (error !== undefined) {
        // Browsers also emit end after an error. Show the diagnostic after resetting the mic.
        rec.onresult = null;
        this.options.onError?.(error);
      }
    };
    rec.onerror = ({ error }) => {
      if (error && error !== "no-speech" && error !== "aborted") {
        finish(webSpeechError(error));
      }
    };
    rec.onend = () => finish();
    this.systemRecognition = rec;
    this.setDictationState("listening");
    try {
      rec.start();
      return true;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      finish(webSpeechError(name, error));
      return false;
    }
  }
}
