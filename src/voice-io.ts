import {
  DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
  DaemonClient,
  OpenAiCompatAsrTransport,
  createAsrReplacer,
} from "@voice-mode/core";
import {
  AecBargeInMonitor,
  CloudDictationSession,
  FocusTextInjector,
  SherpaWorkerClient,
  computeChunkRms,
  isWorkerRequest,
  type AudioCaptureFactory,
  type BargeInCaptureFactory,
  type BargeInEvent,
  type BargeInStartResult,
  type DictationSessionState,
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

/**
 * Lightweight zero-WASM in-memory VAD Worker implementing the `@voice-mode/browser`
 * `WorkerLike` contract so `SherpaWorkerClient` + `AecBargeInMonitor` operate out of
 * the box in SillyTavern Git installs without downloading ONNX/WASM bundles.
 */
export function createEnergyVadWorkerClient(
  minSpeechRms = 0.012,
): SherpaWorkerClient {
  return new SherpaWorkerClient({
    createWorkerSource: () => "/* voice-mode energy+zcr vad */",
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
            const plausibleBand = zcr >= 0.005 && zcr <= 0.45;
            const isSpeech = rms >= minSpeechRms && plausibleBand;
            const speechProbability = isSpeech
              ? Math.min(0.99, 0.5 + rms * 2)
              : Math.min(0.4, rms * 10);
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

export interface VoiceModeIoControllerOptions {
  getSettings: () => VoiceModeExtensionSettings;
  getSecret: (slot: SecretSlot) => Promise<string | null>;
  getWindow: () => (WindowOriginLike & Record<string, unknown>) | null;
  getDocument: () => Document | null;
  isGenerating: () => boolean;
  stopGeneration: () => boolean;
  cancelPlayback: () => void;
  fetchImpl?: typeof fetch;
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
  private cloudSession: CloudDictationSession | null = null;
  private daemonAsrClient: DaemonClient | null = null;
  private systemRecognition: BrowserSpeechRecognitionLike | null = null;
  private dictationState: DictationSessionState = "idle";
  private bargeInCount = 0;

  constructor(options: VoiceModeIoControllerOptions) {
    this.options = options;
    this.vadWorkerClient = createEnergyVadWorkerClient();
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
    void this.monitor.stop();
    this.options.cancelPlayback();
    if (this.options.isGenerating()) {
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
    return this.monitor.start({
      bargeInMode: settings.bargeInMode,
      usesSystemTts: overrides?.usesSystemTts ?? settings.defaultVoice.engine === "system",
    });
  }

  async disarmBargeIn(): Promise<void> {
    await this.monitor.stop();
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

    await this.stopDictation();
    this.triggerBargeIn("manual");

    const settings = this.options.getSettings();
    if (settings.asrEngine === "system") {
      return this.startBrowserSpeechRecognition(settings);
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
    if (this.systemRecognition) {
      try {
        this.systemRecognition.stop();
      } catch {
        // Ignore browser SpeechRecognition stop errors.
      }
      this.systemRecognition = null;
      this.setDictationState("idle");
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
    await this.stopDictation();
    await this.monitor.stop();
    await this.vadWorkerClient.dispose();
  }

  private setDictationState(state: DictationSessionState): void {
    this.dictationState = state;
    this.options.onDictationStateChange?.(state);
  }

  private startBrowserSpeechRecognition(
    settings: VoiceModeExtensionSettings,
  ): boolean {
    const win = this.options.getWindow();
    const Ctor = (win?.SpeechRecognition ?? win?.webkitSpeechRecognition) as
      | (new () => BrowserSpeechRecognitionLike)
      | undefined;
    if (typeof Ctor !== "function") {
      this.options.onError?.(
        new Error(
          "Browser SpeechRecognition is unavailable; select OpenAI-Compatible or Local Voice Daemon ASR.",
        ),
      );
      return false;
    }

    const rec = new Ctor();
    rec.lang =
      settings.asrLanguage && settings.asrLanguage !== "auto"
        ? settings.asrLanguage
        : "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (ev) => {
      const parts: string[] = [];
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        const top = res?.[0];
        if (top?.transcript) parts.push(top.transcript);
      }
      const joined = parts.join(" ").trim();
      if (joined) this.injectDictatedText(joined);
    };
    rec.onerror = (ev) => {
      if (ev.error && ev.error !== "no-speech" && ev.error !== "aborted") {
        this.options.onError?.(new Error(`SpeechRecognition error: ${ev.error}`));
      }
    };
    rec.onend = () => {
      if (this.systemRecognition === rec) {
        this.systemRecognition = null;
        this.setDictationState("idle");
      }
    };
    this.systemRecognition = rec;
    this.setDictationState("listening");
    rec.start();
    return true;
  }
}
