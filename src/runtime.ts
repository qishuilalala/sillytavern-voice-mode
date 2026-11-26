import { buildEmotionPromptInstruction } from "@voice-mode/core";
import type { AudioSink } from "@voice-mode/browser";
import {
  EMOTION_PROMPT_KEY,
  SillyTavernSecretBroker,
  ensureExtensionSettings,
  formatSafeError,
  type HostSecretsAdapter,
  type SecretSlot,
  type SecureOriginStatus,
  type VoiceModeExtensionSettings,
  type WindowOriginLike,
} from "./settings.ts";
import { StreamingUtteranceRouter } from "./stream-router.ts";
import {
  VoiceModeTtsHub,
  type UtterancePlaybackInfo,
} from "./tts-hub.ts";
import { VoiceModeIoController } from "./voice-io.ts";
import { buildSettingsDrawer } from "./settings-drawer.ts";
import { createUiText, type HostTranslate } from "./ui-text.ts";

export interface HostEventSource {
  on(event: string, listener: (...args: unknown[]) => unknown): void;
  makeLast?(event: string, listener: (...args: unknown[]) => unknown): void;
  removeListener(event: string, listener: (...args: unknown[]) => unknown): void;
}

export interface HostCharacter {
  name: string;
  avatar: string;
  data?: {
    extensions?: Record<string, unknown>;
  };
}

export interface HostChatMessage {
  name: string;
  is_user: boolean;
  is_system?: boolean;
  mes: string;
  original_avatar?: string;
  extra?: Record<string, unknown>;
}

export interface HostContext {
  chat: HostChatMessage[];
  characters: HostCharacter[];
  groups: Array<{ id: string; name: string; members: string[] }>;
  name1: string;
  name2: string;
  characterId: number | undefined;
  groupId: string | null;
  chatId: string | undefined;
  streamingProcessor: { isFinished: boolean; isStopped: boolean } | null;
}

export interface SillyTavernHostBridge {
  eventSource: HostEventSource;
  eventTypes: Record<string, string>;
  extensionPromptTypes: { readonly IN_CHAT: number; readonly [k: string]: number };
  extensionPromptRoles: { readonly SYSTEM: number; readonly [k: string]: number };
  extensionSettings: Record<string, unknown>;
  getContext: () => HostContext;
  saveSettingsDebounced: () => void;
  isGenerating: () => boolean;
  stopGeneration: () => boolean;
  setExtensionPrompt: (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
  ) => void;
  getRequestHeaders: (options?: { omitContentType?: boolean }) => Record<string, string>;
  secrets: HostSecretsAdapter;
  translate?: HostTranslate;
  fetchImpl?: typeof fetch;
  sink?: AudioSink;
  getWindow?: () => (WindowOriginLike & Record<string, unknown>) | null;
  getDocument?: () => Document | null;
}

export interface VoiceModeDiagnostics {
  activated: boolean;
  emotionPromptRegistered: boolean;
  firstSentenceLeadMs: number;
  lastFirstUtteranceAtMs: number;
  lastGenerationEndedAtMs: number;
  totalBargeIns: number;
  lastDaemonFallbackReason: string;
  lastError: string;
  secureOrigin: SecureOriginStatus;
  utteranceHistory: UtterancePlaybackInfo[];
}

export interface VoiceModeRuntime {
  activate(): Promise<void>;
  dispose(): Promise<void>;
  getSettings(): VoiceModeExtensionSettings;
  updateSettings(mutator: (draft: VoiceModeExtensionSettings) => void): VoiceModeExtensionSettings;
  setSecret(slot: SecretSlot, value: string): Promise<void>;
  syncEmotionPrompt(): void;
  triggerBargeIn(source?: "aec3" | "manual"): void;
  startDictation(): Promise<boolean>;
  stopDictation(): Promise<void>;
  mountSettingsDrawer(doc?: Document | null): HTMLElement | null;
  waitUntilIdle(): Promise<void>;
  getDiagnostics(): VoiceModeDiagnostics;
}

export function createVoiceModeRuntime(host: SillyTavernHostBridge): VoiceModeRuntime {
  let activated = false;
  let emotionPromptRegistered = false;
  let inFlightGenerationEvent = false;
  let turnFirstPlayStartMs = 0;
  let turnEndedMs = 0;
  let firstSentenceLeadMs = 0;
  let lastDaemonFallbackReason = "";
  let lastError = "";
  const utteranceHistory: UtterancePlaybackInfo[] = [];
  const cleanups: Array<() => void> = [];

  const getWin = () =>
    host.getWindow
      ? host.getWindow()
      : typeof window !== "undefined"
        ? (window as unknown as WindowOriginLike & Record<string, unknown>)
        : null;
  const getDoc = () =>
    host.getDocument
      ? host.getDocument()
      : typeof document !== "undefined"
        ? document
        : null;

  const secretBroker = new SillyTavernSecretBroker(host.secrets);
  const getSettings = () => ensureExtensionSettings(host.extensionSettings);

  const isHostGenerating = (): boolean => {
    if (host.isGenerating() || inFlightGenerationEvent) return true;
    try {
      const sp = host.getContext().streamingProcessor;
      return Boolean(sp && !sp.isFinished && !sp.isStopped);
    } catch {
      return false;
    }
  };

  const resolveActiveSpeaker = (): { speaker: string; avatar?: string } => {
    try {
      const ctx = host.getContext();
      const ch =
        typeof ctx.characterId === "number"
          ? ctx.characters[ctx.characterId]
          : undefined;
      if (ch) {
        return {
          speaker: ch.name || ctx.name2 || "",
          avatar: ch.avatar,
        };
      }
      // Group chats leave characterId unset. ST fills name/original_avatar on the
      // message being generated before streaming, so resolve the speaking member
      // there instead of falling back to the group name (which breaks Voice Map).
      if (typeof ctx.groupId === "string" && ctx.groupId.length > 0) {
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const last = chat[chat.length - 1];
        if (last && !last.is_user && !last.is_system) {
          const name = typeof last.name === "string" ? last.name : "";
          const avatar =
            typeof last.original_avatar === "string" ? last.original_avatar : undefined;
          const matched = name
            ? ctx.characters.find((c) => c.name === name)
            : undefined;
          return {
            speaker: matched?.name ?? name ?? ctx.name2 ?? "",
            avatar: avatar ?? matched?.avatar,
          };
        }
      }
      return { speaker: ctx.name2 || "" };
    } catch {
      return { speaker: "" };
    }
  };

  const getCharacterCardVoice = (speaker: string, avatar?: string): unknown => {
    try {
      const ctx = host.getContext();
      const found = ctx.characters.find(
        (c) => (avatar && c.avatar === avatar) || (speaker && c.name === speaker),
      );
      return found?.data?.extensions?.voice_mode;
    } catch {
      return undefined;
    }
  };

  const text = createUiText(host.translate);
  let drawer: ReturnType<typeof buildSettingsDrawer> | undefined;
  const refreshStatusText = (message: string) => drawer?.setStatus(message);
  const showMicError = (err: unknown) => {
    lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
    let key = "mic_error";
    switch (err instanceof Error ? err.name : "") {
      case "NotAllowedError":
        key = "mic_permission";
        break;
      case "ServiceNotAllowedError":
        key = "mic_service";
        break;
      case "NotSupportedError":
        key = "mic_unsupported";
    }
    refreshStatusText(text(key, "Mic: {0}", lastError));
  };

  const ttsHub = new VoiceModeTtsHub({
    getSettings,
    getSecret: (slot) => secretBroker.getSecret(slot),
    getCharacterCardVoice,
    getRequestHeaders: () => host.getRequestHeaders(),
    fetchImpl: host.fetchImpl,
    sink: host.sink,
    onUtteranceStart: (info) => {
      if (turnFirstPlayStartMs === 0) {
        turnFirstPlayStartMs = info.startedAtMs;
      }
      utteranceHistory.push(info);
      if (utteranceHistory.length > 50) utteranceHistory.shift();
      const role = text(info.role, info.role);
      refreshStatusText(text("speaking", "Speaking ({0}: {1})", role, info.voice || info.engine));
    },
    onStateChange: (state) => {
      if (state === "playing") {
        const s = getSettings();
        if (s.bargeInMode !== "manual" && !ttsHub.usesSystemTts) {
          void io.armBargeIn({ usesSystemTts: false }).catch((err) => {
            lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
          });
        }
      } else if (state === "idle" && !isHostGenerating()) {
        void io.disarmBargeIn();
        refreshStatusText(text("ready", "Ready"));
      }
    },
    onDaemonFallback: (reason) => {
      lastDaemonFallbackReason = formatSafeError(
        reason,
        secretBroker.knownSecretsSnapshot(),
      );
      refreshStatusText(text("daemon_fallback", "Daemon offline -> System TTS fallback"));
    },
    onError: (err) => {
      lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
      refreshStatusText(text("tts_error", "Error: {0}", lastError));
    },
  });

  const router = new StreamingUtteranceRouter({
    narrationSplitEnabled: getSettings().narrationSplitEnabled,
    resolveActiveSpeaker,
    onUtterance: (utterance) => {
      ttsHub.enqueueUtterance(utterance);
    },
  });

  const io = new VoiceModeIoController({
    getSettings,
    getSecret: (slot) => secretBroker.getSecret(slot),
    getWindow: getWin,
    getDocument: getDoc,
    isGenerating: isHostGenerating,
    stopGeneration: () => host.stopGeneration(),
    cancelPlayback: () => {
      router.reset();
      ttsHub.cancel();
    },
    fetchImpl: host.fetchImpl,
    onInsecureOrigin: (status) => drawer?.showOriginStatus(status),
    onDictationStateChange: (state) => {
      drawer?.setDictationState(state);
      refreshStatusText(state === "idle"
        ? text("ready", "Ready")
        : text(`mic_${state}`, "Mic: {0}", state));
    },
    onError: showMicError,
  });

  const syncEmotionPrompt = (): void => {
    const s = getSettings();
    const active = s.enabled && s.emotionPromptEnabled;
    const promptValue = active
      ? buildEmotionPromptInstruction({ allowRoleplayNarration: true })
      : "";
    host.setExtensionPrompt(
      EMOTION_PROMPT_KEY,
      promptValue,
      host.extensionPromptTypes.IN_CHAT,
      0,
      false,
      host.extensionPromptRoles.SYSTEM,
    );
    emotionPromptRegistered = active;
  };

  const updateSettings = (
    mutator: (draft: VoiceModeExtensionSettings) => void,
  ): VoiceModeExtensionSettings => {
    const current = getSettings();
    mutator(current);
    const normalized = ensureExtensionSettings(host.extensionSettings);
    router.setNarrationSplitEnabled(normalized.narrationSplitEnabled);
    syncEmotionPrompt();
    host.saveSettingsDebounced();
    return normalized;
  };

  const subscribe = (
    eventName: string | undefined,
    fn: (...args: unknown[]) => unknown,
    useMakeLast = false,
  ) => {
    if (!eventName) return;
    if (useMakeLast && typeof host.eventSource.makeLast === "function") {
      host.eventSource.makeLast(eventName, fn);
    } else {
      host.eventSource.on(eventName, fn);
    }
    cleanups.push(() => host.eventSource.removeListener(eventName, fn));
  };

  const toggleDictation = () => {
    if (io.activeDictationState !== "idle") {
      void io.stopDictation().catch(showMicError);
    } else {
      void io.startDictation().catch(showMicError);
    }
  };

  const mountSettingsDrawer = (explicitDoc?: Document | null): HTMLElement | null => {
    const doc = explicitDoc ?? getDoc();
    if (!doc) return null;
    const existing = doc.getElementById("voice_mode_settings_drawer");
    if (existing) return existing;
    const hostContainer =
      doc.getElementById("extensions_settings") ??
      doc.getElementById("extensions_settings2");
    if (!hostContainer) return null;

    drawer = buildSettingsDrawer(doc, hostContainer, {
      text,
      getSettings,
      updateSettings,
      resolveActiveSpeaker,
      originStatus: io.checkSecureOrigin(),
      triggerBargeIn: () => io.triggerBargeIn("manual"),
      async saveSecret(slot, value) {
        try {
          await secretBroker.setSecret(slot, value);
          refreshStatusText(value.trim()
            ? text("secret_saved", "Server secret saved.")
            : text("secret_deleted", "Server secret cleared."));
        } catch (err) {
          lastError = formatSafeError(err, [...secretBroker.knownSecretsSnapshot(), value.trim()]);
          refreshStatusText(text("secret_failed", "Could not update the server secret. Check SillyTavern and try again."));
        }
      },
      toggleDictation,
    });
    return drawer.root;
  };

  return {
    async activate(): Promise<void> {
      if (activated) return;
      activated = true;
      const initial = getSettings();
      router.setNarrationSplitEnabled(initial.narrationSplitEnabled);
      syncEmotionPrompt();
      mountSettingsDrawer();

      const et = host.eventTypes;
      subscribe(et.APP_READY, () => {
        mountSettingsDrawer();
      });
      subscribe(et.GENERATION_STARTED, (type, _opts, dryRun) => {
        const genType = typeof type === "string" ? type : "normal";
        const isIgnored =
          dryRun === true || genType === "quiet" || genType === "impersonate";
        inFlightGenerationEvent = !isIgnored;
        turnFirstPlayStartMs = 0;
        turnEndedMs = 0;
        firstSentenceLeadMs = 0;
        const active = resolveActiveSpeaker();
        router.onGenerationStarted({
          type: genType,
          dryRun: dryRun === true,
          speaker: active.speaker,
          avatar: active.avatar,
        });
      });
      subscribe(et.STREAM_TOKEN_RECEIVED, (cumulativeText) => {
        if (!getSettings().enabled) return;
        router.onStreamToken(typeof cumulativeText === "string" ? cumulativeText : "");
      });
      subscribe(et.GENERATION_ENDED, () => {
        inFlightGenerationEvent = false;
        turnEndedMs = Date.now();
        if (turnFirstPlayStartMs > 0 && turnEndedMs >= turnFirstPlayStartMs) {
          firstSentenceLeadMs = turnEndedMs - turnFirstPlayStartMs;
        }
        if (getSettings().enabled) {
          router.onGenerationEnded();
        } else {
          router.reset();
        }
      });
      subscribe(et.GENERATION_STOPPED, () => {
        inFlightGenerationEvent = false;
        router.onGenerationStopped();
        ttsHub.cancel();
        void io.disarmBargeIn();
      });
      subscribe(
        et.CHARACTER_MESSAGE_RENDERED,
        (messageId, type) => {
          if (!getSettings().enabled) return;
          const idx = typeof messageId === "number" ? messageId : -1;
          const ctx = host.getContext();
          const msg = idx >= 0 ? ctx.chat[idx] : undefined;
          router.onCharacterMessageRendered({
            messageId: idx,
            type: typeof type === "string" ? type : undefined,
            message: msg,
          });
        },
        true,
      );
      const resetAll = () => {
        inFlightGenerationEvent = false;
        router.onChatChanged();
        ttsHub.cancel();
        void io.disarmBargeIn();
        drawer?.refreshCharacter();
      };
      subscribe(et.CHAT_CHANGED, resetAll);
      subscribe(et.GROUP_UPDATED, () => drawer?.refreshCharacter());
      subscribe(et.MESSAGE_SWIPED, resetAll);
      subscribe(et.MESSAGE_DELETED, resetAll);

      const doc = getDoc();
      if (doc) {
        const onKeyDown = (ev: KeyboardEvent) => {
          if (ev.altKey && ev.shiftKey && ev.code === "KeyB") {
            ev.preventDefault();
            io.triggerBargeIn("manual");
          } else if (ev.altKey && ev.shiftKey && ev.code === "KeyV") {
            ev.preventDefault();
            toggleDictation();
          }
        };
        doc.addEventListener("keydown", onKeyDown);
        cleanups.push(() => doc.removeEventListener("keydown", onKeyDown));
      }

      host.saveSettingsDebounced();
    },

    async dispose(): Promise<void> {
      for (const fn of cleanups.splice(0)) {
        fn();
      }
      router.reset();
      await io.dispose();
      await ttsHub.dispose();
      activated = false;
    },

    getSettings,
    updateSettings,
    setSecret: (slot, value) => secretBroker.setSecret(slot, value),
    syncEmotionPrompt,
    triggerBargeIn: (source = "manual") => io.triggerBargeIn(source),
    startDictation: () => io.startDictation(),
    stopDictation: () => io.stopDictation(),
    mountSettingsDrawer,
    waitUntilIdle: () => ttsHub.waitUntilDrained(),
    getDiagnostics(): VoiceModeDiagnostics {
      return {
        activated,
        emotionPromptRegistered,
        firstSentenceLeadMs,
        lastFirstUtteranceAtMs: turnFirstPlayStartMs,
        lastGenerationEndedAtMs: turnEndedMs,
        totalBargeIns: io.totalBargeIns,
        lastDaemonFallbackReason,
        lastError,
        secureOrigin: io.checkSecureOrigin(),
        utteranceHistory: [...utteranceHistory],
      };
    },
  };
}
