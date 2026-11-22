import {
  KOKORO_DEFAULT_SPEAKERS,
  buildEmotionPromptInstruction,
} from "@voice-mode/core";
import type { AudioSink, BargeInMode } from "@voice-mode/browser";
import {
  EMOTION_PROMPT_KEY,
  SillyTavernSecretBroker,
  ensureExtensionSettings,
  formatSafeError,
  type HostSecretsAdapter,
  type SecretSlot,
  type SecureOriginStatus,
  type StAsrEngineKind,
  type StTtsEngineKind,
  type VoiceModeExtensionSettings,
  type WindowOriginLike,
} from "./settings.ts";
import { StreamingUtteranceRouter } from "./stream-router.ts";
import {
  VoiceModeTtsHub,
  type UtterancePlaybackInfo,
} from "./tts-hub.ts";
import { VoiceModeIoController } from "./voice-io.ts";

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

function makeEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
      return {
        speaker: ch?.name || ctx.name2 || "",
        avatar: ch?.avatar,
      };
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

  let statusBadgeEl: HTMLElement | null = null;
  let insecureBannerEl: HTMLElement | null = null;
  let refreshCharVoiceUi: (() => void) | null = null;
  const refreshStatusText = (msg: string) => {
    if (statusBadgeEl) statusBadgeEl.textContent = msg;
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
      refreshStatusText(`Speaking (${info.role}: ${info.voice || info.engine})`);
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
        refreshStatusText("Ready");
      }
    },
    onDaemonFallback: (reason) => {
      lastDaemonFallbackReason = formatSafeError(
        reason,
        secretBroker.knownSecretsSnapshot(),
      );
      refreshStatusText("Daemon offline -> System TTS fallback");
    },
    onError: (err) => {
      lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
      refreshStatusText(`Error: ${lastError}`);
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
    onInsecureOrigin: (status) => {
      if (insecureBannerEl && !status.secure) {
        insecureBannerEl.textContent = status.remediation;
        insecureBannerEl.hidden = false;
      }
    },
    onDictationStateChange: (state) => {
      refreshStatusText(state === "idle" ? "Ready" : `Mic: ${state}`);
    },
    onError: (err) => {
      lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
      refreshStatusText(`Mic: ${lastError}`);
    },
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

  const mountSettingsDrawer = (explicitDoc?: Document | null): HTMLElement | null => {
    const doc = explicitDoc ?? getDoc();
    if (!doc) return null;
    const existing = doc.getElementById("voice_mode_settings_drawer");
    if (existing) return existing;

    const hostContainer =
      doc.getElementById("extensions_settings") ??
      doc.getElementById("extensions_settings2");
    if (!hostContainer) return null;

    const settings = getSettings();
    const root = makeEl(doc, "div", "inline-drawer vm-st-drawer");
    root.id = "voice_mode_settings_drawer";

    const header = makeEl(doc, "div", "inline-drawer-toggle inline-drawer-header");
    const title = makeEl(doc, "b", undefined, "Voice Mode");
    statusBadgeEl = makeEl(doc, "span", "vm-st-status-badge", "Ready");
    const icon = makeEl(doc, "div", "inline-drawer-icon fa-solid fa-circle-chevron-down down");
    header.append(title, statusBadgeEl, icon);

    const content = makeEl(doc, "div", "inline-drawer-content vm-st-settings");

    // Proactive Secure Context Banner
    const originStatus = io.checkSecureOrigin();
    insecureBannerEl = makeEl(
      doc,
      "div",
      "vm-st-insecure-banner",
      originStatus.remediation,
    );
    insecureBannerEl.dataset.vmInsecureBanner = "true";
    insecureBannerEl.hidden = originStatus.secure;
    content.appendChild(insecureBannerEl);

    const addCheckbox = (
      id: string,
      labelText: string,
      checked: boolean,
      onChange: (next: boolean) => void,
    ) => {
      const row = makeEl(doc, "label", "checkbox_label vm-st-row");
      const input = makeEl(doc, "input") as HTMLInputElement;
      input.type = "checkbox";
      input.id = id;
      input.checked = checked;
      input.addEventListener("change", () => onChange(input.checked));
      row.append(input, makeEl(doc, "span", undefined, labelText));
      content.appendChild(row);
    };

    addCheckbox("vm_st_enabled", "Enable Streaming Voice Mode", settings.enabled, (v) => {
      updateSettings((d) => {
        d.enabled = v;
      });
      if (!v) io.triggerBargeIn("manual");
    });
    addCheckbox(
      "vm_st_narration_split",
      "Separate *Narration* and Dialogue Voices",
      settings.narrationSplitEnabled,
      (v) => updateSettings((d) => void (d.narrationSplitEnabled = v)),
    );
    addCheckbox(
      "vm_st_emotion_prompt",
      "Inject Emotion Cue System Prompt (<whisper>, <break>)",
      settings.emotionPromptEnabled,
      (v) => updateSettings((d) => void (d.emotionPromptEnabled = v)),
    );
    addCheckbox(
      "vm_st_auto_send",
      "Auto-Send Message After Voice Dictation",
      settings.autoSendOnDictation,
      (v) => updateSettings((d) => void (d.autoSendOnDictation = v)),
    );
    addCheckbox(
      "vm_st_use_server_proxy",
      "Route Cloud TTS via Optional Server Plugin Proxy (/api/plugins/voice-mode)",
      settings.useServerPluginProxy,
      (v) => updateSettings((d) => void (d.useServerPluginProxy = v)),
    );

    const datalist = makeEl(doc, "datalist");
    datalist.id = "vm_st_kokoro_voices";
    for (const preset of KOKORO_DEFAULT_SPEAKERS) {
      const opt = makeEl(doc, "option");
      opt.value = preset.id;
      opt.textContent = `${preset.label} (${preset.lang})`;
      datalist.appendChild(opt);
    }
    content.appendChild(datalist);

    const makeSelect = (
      id: string,
      items: ReadonlyArray<readonly [string, string]>,
      initial: string,
      onChange?: (val: string) => void,
    ): HTMLSelectElement => {
      const sel = makeEl(doc, "select", "text_pole");
      sel.id = id;
      for (const [val, label] of items) {
        const opt = makeEl(doc, "option", undefined, label);
        opt.value = val;
        opt.selected = val === initial;
        sel.appendChild(opt);
      }
      if (onChange) sel.addEventListener("change", () => onChange(sel.value));
      return sel;
    };

    const makeInput = (
      id: string,
      type: string,
      placeholder: string,
      initial = "",
    ): HTMLInputElement => {
      const inp = makeEl(doc, "input", "text_pole");
      inp.type = type;
      inp.id = id;
      inp.placeholder = placeholder;
      inp.value = initial;
      return inp;
    };

    const ENGINE_OPTIONS = [
      ["system", "Browser System TTS (Zero Config)"],
      ["kokoro-daemon", "Local Kokoro Daemon (103 Voices)"],
      ["openai-compat", "OpenAI-Compatible BYOK TTS"],
      ["mimo", "Xiaomi MiMo TTS"],
    ] as const;

    const buildVoiceRow = (
      prefix: string,
      heading: string,
      currentEngine: StTtsEngineKind,
      currentVoice: string,
      onUpdate: (engine: StTtsEngineKind, voice: string) => void,
    ) => {
      const wrap = makeEl(doc, "div", "vm-st-field-group");
      wrap.appendChild(makeEl(doc, "label", undefined, heading));
      const select = makeSelect(`${prefix}_engine`, ENGINE_OPTIONS, currentEngine);
      const voiceInput = makeInput(
        `${prefix}_voice`,
        "text",
        "Voice ID (zf_001, alloy, default)",
        currentVoice,
      );
      voiceInput.setAttribute("list", "vm_st_kokoro_voices");
      const commit = () =>
        onUpdate(select.value as StTtsEngineKind, voiceInput.value.trim());
      select.addEventListener("change", commit);
      voiceInput.addEventListener("change", commit);
      wrap.append(select, voiceInput);
      content.appendChild(wrap);
    };

    buildVoiceRow(
      "vm_st_default",
      "Default Character Voice",
      settings.defaultVoice.engine,
      settings.defaultVoice.voice,
      (engine, voice) =>
        updateSettings((d) => {
          d.defaultVoice = { engine, voice };
        }),
    );
    buildVoiceRow(
      "vm_st_narrator",
      "Narrator Voice (*action*)",
      settings.narratorVoice.engine,
      settings.narratorVoice.voice,
      (engine, voice) =>
        updateSettings((d) => {
          d.narratorVoice = { engine, voice };
        }),
    );

    const charWrap = makeEl(doc, "div", "vm-st-field-group");
    charWrap.id = "vm_st_char_voice_section";
    const charLabel = makeEl(doc, "label", undefined, "Active Character Voice Override");
    charLabel.id = "vm_st_active_char_label";
    const charEngineSelect = makeSelect(
      "vm_st_char_engine",
      [["", "Inherit Default Character Voice"], ...ENGINE_OPTIONS],
      "",
    );
    const charVoiceInput = makeInput(
      "vm_st_char_voice",
      "text",
      "Character Voice ID override",
    );
    charVoiceInput.setAttribute("list", "vm_st_kokoro_voices");
    const charResetBtn = makeEl(
      doc,
      "button",
      "menu_button",
      "Reset Character Voice",
    );
    charResetBtn.type = "button";
    charResetBtn.id = "vm_st_char_reset_btn";

    const activeVoiceKey = () => {
      const a = resolveActiveSpeaker();
      return { key: a.avatar || a.speaker || "", label: a.speaker || a.avatar || "(None)" };
    };
    refreshCharVoiceUi = () => {
      const { key, label } = activeVoiceKey();
      const entry = key ? getSettings().voiceMap[key] : undefined;
      charLabel.textContent = `Active Character Voice: ${label}`;
      charEngineSelect.value = entry ? entry.engine : "";
      charVoiceInput.value = entry ? entry.voice : "";
      charEngineSelect.disabled = charVoiceInput.disabled = charResetBtn.disabled = !key;
    };
    const commitCharOverride = () => {
      const { key } = activeVoiceKey();
      if (!key) return;
      const eng = charEngineSelect.value as StTtsEngineKind | "";
      const v = charVoiceInput.value.trim();
      updateSettings((d) => {
        if (!eng && !v) delete d.voiceMap[key];
        else d.voiceMap[key] = { engine: (eng || d.defaultVoice.engine) as StTtsEngineKind, voice: v };
      });
      refreshCharVoiceUi?.();
    };
    charEngineSelect.addEventListener("change", commitCharOverride);
    charVoiceInput.addEventListener("change", commitCharOverride);
    charResetBtn.addEventListener("click", () => {
      const { key } = activeVoiceKey();
      if (key) updateSettings((d) => void delete d.voiceMap[key]);
      refreshCharVoiceUi?.();
    });
    charWrap.append(charLabel, charEngineSelect, charVoiceInput, charResetBtn);
    content.appendChild(charWrap);
    refreshCharVoiceUi();

    const endpointsWrap = makeEl(doc, "div", "vm-st-field-group");
    endpointsWrap.appendChild(makeEl(doc, "label", undefined, "Endpoint Base URLs"));
    for (const [id, ph, key] of [
      ["vm_st_openai_tts_base_url", "OpenAI TTS URL", "openaiTtsBaseUrl"],
      ["vm_st_asr_base_url", "OpenAI ASR URL", "asrBaseUrl"],
      ["vm_st_daemon_base_url", "Local Daemon URL", "daemonBaseUrl"],
    ] as const) {
      const inp = makeInput(id, "url", ph, settings[key]);
      inp.addEventListener("change", () => {
        updateSettings((d) => {
          d[key] = inp.value.trim();
        });
        inp.value = getSettings()[key];
      });
      endpointsWrap.appendChild(inp);
    }
    content.appendChild(endpointsWrap);

    const bargeWrap = makeEl(doc, "div", "vm-st-field-group");
    bargeWrap.appendChild(makeEl(doc, "label", undefined, "Voice Barge-In & ASR Engine"));
    const bargeSelect = makeSelect(
      "vm_st_barge_mode",
      [
        ["detect", "AEC3 Auto-Detect (Safe Default)"],
        ["auto", "Force Hands-Free Barge-In"],
        ["manual", "Manual Button / Hotkey Only"],
      ],
      settings.bargeInMode,
      (v) => updateSettings((d) => void (d.bargeInMode = v as BargeInMode)),
    );
    const asrSelect = makeSelect(
      "vm_st_asr_engine",
      [
        ["system", "Browser SpeechRecognition ASR"],
        ["daemon", "Local Voice Daemon ASR"],
        ["openai-compat", "OpenAI-Compatible Whisper ASR"],
      ],
      settings.asrEngine,
      (v) => updateSettings((d) => void (d.asrEngine = v as StAsrEngineKind)),
    );
    bargeWrap.append(bargeSelect, asrSelect);
    content.appendChild(bargeWrap);

    const secretWrap = makeEl(doc, "div", "vm-st-field-group");
    secretWrap.appendChild(makeEl(doc, "label", undefined, "Server Secrets (/api/secrets/write)"));
    const slotSelect = makeSelect(
      "vm_st_secret_slot",
      [
        ["openaiTts", "OpenAI-Compatible TTS Key"],
        ["mimo", "MiMo TTS Key"],
        ["asr", "OpenAI-Compatible ASR Key"],
        ["daemon", "Local Voice Daemon Token"],
      ],
      "openaiTts",
    );
    const secretInput = makeInput("vm_st_secret_input", "password", "Paste secret key");
    secretInput.autocomplete = "off";
    const saveKeyBtn = makeEl(doc, "button", "menu_button", "Save Server Secret");
    saveKeyBtn.type = "button";
    saveKeyBtn.id = "vm_st_save_secret_btn";
    saveKeyBtn.addEventListener("click", () => {
      const slot = slotSelect.value as SecretSlot;
      const val = secretInput.value;
      secretInput.value = "";
      void secretBroker.setSecret(slot, val).then(() => refreshStatusText(`Saved ${slot} secret`));
    });
    secretWrap.append(slotSelect, secretInput, saveKeyBtn);
    content.appendChild(secretWrap);

    // Action Bar: Dictate & Manual Barge-In Stop
    const actions = makeEl(doc, "div", "vm-st-actions");
    const dictateBtn = makeEl(
      doc,
      "button",
      "menu_button",
      "Dictate Mic",
    ) as HTMLButtonElement;
    dictateBtn.type = "button";
    dictateBtn.id = "vm_st_dictate_btn";
    dictateBtn.disabled = !originStatus.secure;
    dictateBtn.addEventListener("click", () => {
      if (io.activeDictationState !== "idle") {
        void io.stopDictation();
      } else {
        void io.startDictation();
      }
    });

    const bargeBtn = makeEl(
      doc,
      "button",
      "menu_button",
      "Stop / Barge-In",
    ) as HTMLButtonElement;
    bargeBtn.type = "button";
    bargeBtn.id = "vm_st_barge_in_btn";
    bargeBtn.addEventListener("click", () => io.triggerBargeIn("manual"));

    actions.append(dictateBtn, bargeBtn);
    content.appendChild(actions);

    root.append(header, content);
    hostContainer.appendChild(root);
    return root;
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
        refreshCharVoiceUi?.();
      };
      subscribe(et.CHAT_CHANGED, resetAll);
      subscribe(et.GROUP_UPDATED, () => refreshCharVoiceUi?.());
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
            if (io.activeDictationState !== "idle") {
              void io.stopDictation();
            } else {
              void io.startDictation();
            }
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
