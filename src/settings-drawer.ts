import { KOKORO_DEFAULT_SPEAKERS } from "@voice-mode/core";
import type { BargeInMode, DictationSessionState } from "@voice-mode/browser";
import type {
  SecretSlot,
  SecureOriginStatus,
  StAsrEngineKind,
  StTtsEngineKind,
  VoiceModeExtensionSettings,
} from "./settings.ts";
import type { UiText } from "./ui-text.ts";

interface DrawerOptions {
  text: UiText;
  getSettings: () => VoiceModeExtensionSettings;
  updateSettings: (mutator: (draft: VoiceModeExtensionSettings) => void) => void;
  resolveActiveSpeaker: () => { speaker: string; avatar?: string };
  originStatus: SecureOriginStatus;
  triggerBargeIn: () => void;
  saveSecret: (slot: SecretSlot, value: string) => Promise<void>;
  toggleDictation: () => void;
  getDiagnostics: () => unknown;
  exportLastReplyAsWav: () => Promise<{
    sentences: number;
    skipped: number;
    reason?: "no-wav-engine" | "empty";
    wav: Uint8Array | null;
  }>;
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

export function buildSettingsDrawer(
  doc: Document,
  hostContainer: HTMLElement,
  options: DrawerOptions,
) {
  const { text, getSettings, updateSettings, resolveActiveSpeaker, originStatus } = options;
  const settings = getSettings();
  const root = makeEl(doc, "div", "inline-drawer vm-st-drawer");
  root.id = "voice_mode_settings_drawer";

  const header = makeEl(doc, "div", "inline-drawer-toggle inline-drawer-header");
  const title = makeEl(doc, "b", undefined, text("title", "Voice Mode"));
  const statusBadgeEl = makeEl(doc, "span", "vm-st-status-badge", text("ready", "Ready"));
  statusBadgeEl.setAttribute("role", "status");
  const icon = makeEl(doc, "div", "inline-drawer-icon fa-solid fa-circle-chevron-down down");
  header.append(title, statusBadgeEl, icon);

  const content = makeEl(doc, "div", "inline-drawer-content vm-st-settings");

  const insecureBannerEl = makeEl(
    doc,
    "div",
    "vm-st-insecure-banner",
  );
  insecureBannerEl.dataset.vmInsecureBanner = "true";
  const showOriginStatus = (status: SecureOriginStatus) => {
    insecureBannerEl.hidden = status.secure;
    insecureBannerEl.textContent = status.secure
      ? ""
      : text("insecure_origin", "{0}", status.remediation, status.originLabel);
  };
  showOriginStatus(originStatus);
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

  addCheckbox("vm_st_enabled", text("enabled", "Enable Streaming Voice Mode"), settings.enabled, (v) => {
    updateSettings((d) => {
      d.enabled = v;
    });
    if (!v) options.triggerBargeIn();
  });
  addCheckbox(
    "vm_st_narration_split",
    text("narration_split", "Separate *Narration* and Dialogue Voices"),
    settings.narrationSplitEnabled,
    (v) => updateSettings((d) => void (d.narrationSplitEnabled = v)),
  );
  addCheckbox(
    "vm_st_emotion_prompt",
    text("emotion_prompt", "Inject Emotion Cue System Prompt (<whisper>, <break>)"),
    settings.emotionPromptEnabled,
    (v) => updateSettings((d) => void (d.emotionPromptEnabled = v)),
  );
  addCheckbox(
    "vm_st_auto_send",
    text("auto_send", "Auto-Send Message After Voice Dictation"),
    settings.autoSendOnDictation,
    (v) => updateSettings((d) => void (d.autoSendOnDictation = v)),
  );
  addCheckbox(
    "vm_st_semantic_endpoint",
    text("semantic_endpoint", "Stop Dictation When the Sentence Is Complete (Browser ASR)"),
    settings.semanticEndpoint,
    (v) => updateSettings((d) => void (d.semanticEndpoint = v)),
  );
  addCheckbox(
    "vm_st_use_server_proxy",
    text("server_proxy", "Route Cloud TTS via Optional Server Plugin Proxy (/api/plugins/voice-mode)"),
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
    ["system", text("tts_system", "Browser System TTS (Zero Config)")],
    ["kokoro-daemon", text("tts_kokoro", "Local Kokoro Daemon (103 Voices)")],
    ["openai-compat", text("tts_openai", "OpenAI-Compatible BYOK TTS")],
    ["mimo", text("tts_mimo", "Xiaomi MiMo TTS")],
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
      text("voice_id", "Voice ID (zf_001, alloy, default)"),
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
    text("default_voice", "Default Character Voice"),
    settings.defaultVoice.engine,
    settings.defaultVoice.voice,
    (engine, voice) =>
      updateSettings((d) => {
        d.defaultVoice = { engine, voice };
      }),
  );
  buildVoiceRow(
    "vm_st_narrator",
    text("narrator_voice", "Narrator Voice (*action*)"),
    settings.narratorVoice.engine,
    settings.narratorVoice.voice,
    (engine, voice) =>
      updateSettings((d) => {
        d.narratorVoice = { engine, voice };
      }),
  );

  const charWrap = makeEl(doc, "div", "vm-st-field-group");
  charWrap.id = "vm_st_char_voice_section";
  const charLabel = makeEl(doc, "label");
  charLabel.id = "vm_st_active_char_label";
  const charEngineSelect = makeSelect(
    "vm_st_char_engine",
    [["", text("inherit_voice", "Inherit Default Character Voice")], ...ENGINE_OPTIONS],
    "",
  );
  const charVoiceInput = makeInput(
    "vm_st_char_voice",
    "text",
    text("character_voice_override", "Character Voice ID override"),
  );
  charVoiceInput.setAttribute("list", "vm_st_kokoro_voices");
  const charResetBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("reset_voice", "Reset Character Voice"),
  );
  charResetBtn.type = "button";
  charResetBtn.id = "vm_st_char_reset_btn";

  const activeVoiceKey = () => {
    const { speaker, avatar } = resolveActiveSpeaker();
    return { key: avatar || speaker, label: speaker || avatar || text("no_character", "(None)") };
  };
  const refreshCharacter = () => {
    const { key, label } = activeVoiceKey();
    const entry = key ? getSettings().voiceMap[key] : undefined;
    charLabel.textContent = text("active_voice", "Active Character Voice: {0}", label);
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
    refreshCharacter();
  };
  charEngineSelect.addEventListener("change", commitCharOverride);
  charVoiceInput.addEventListener("change", commitCharOverride);
  charResetBtn.addEventListener("click", () => {
    const { key } = activeVoiceKey();
    if (key) updateSettings((d) => void delete d.voiceMap[key]);
    refreshCharacter();
  });
  charWrap.append(charLabel, charEngineSelect, charVoiceInput, charResetBtn);
  content.appendChild(charWrap);
  refreshCharacter();

  const endpointsWrap = makeEl(doc, "div", "vm-st-field-group");
  endpointsWrap.appendChild(makeEl(doc, "label", undefined, text("endpoints", "Endpoint Base URLs")));
  for (const [id, ph, key] of [
    ["vm_st_openai_tts_base_url", text("openai_tts_url", "OpenAI TTS URL"), "openaiTtsBaseUrl"],
    ["vm_st_asr_base_url", text("openai_asr_url", "OpenAI ASR URL"), "asrBaseUrl"],
    ["vm_st_daemon_base_url", text("daemon_url", "Local Daemon URL"), "daemonBaseUrl"],
  ] as const) {
    const inp = makeInput(id, "url", ph, settings[key]);
    inp.addEventListener("change", () => {
      updateSettings((d) => {
        d[key] = inp.value.trim();
      });
      inp.value = getSettings()[key];
    });
    const label = makeEl(doc, "label", undefined, ph);
    label.htmlFor = id;
    endpointsWrap.append(label, inp);
  }
  content.appendChild(endpointsWrap);

  const bargeWrap = makeEl(doc, "div", "vm-st-field-group");
  bargeWrap.appendChild(makeEl(doc, "label", undefined, text("barge_and_asr", "Voice Barge-In & ASR Engine")));
  const bargeSelect = makeSelect(
    "vm_st_barge_mode",
    [
      ["detect", text("barge_detect", "AEC3 Auto-Detect (Safe Default)")],
      ["auto", text("barge_auto", "Force Hands-Free Barge-In")],
      ["manual", text("barge_manual", "Manual Button / Hotkey Only")],
    ],
    settings.bargeInMode,
    (v) => updateSettings((d) => void (d.bargeInMode = v as BargeInMode)),
  );
  const asrSelect = makeSelect(
    "vm_st_asr_engine",
    [
      ["system", text("asr_system", "Browser SpeechRecognition ASR")],
      ["daemon", text("asr_daemon", "Local Voice Daemon ASR")],
      ["openai-compat", text("asr_openai", "OpenAI-Compatible Whisper ASR")],
    ],
    settings.asrEngine,
    (v) => updateSettings((d) => void (d.asrEngine = v as StAsrEngineKind)),
  );
  bargeSelect.setAttribute("aria-label", text("barge_mode", "Voice Barge-In mode"));
  asrSelect.setAttribute("aria-label", text("asr_engine", "ASR engine"));
  bargeWrap.append(bargeSelect, asrSelect);
  content.appendChild(bargeWrap);

  const secretWrap = makeEl(doc, "div", "vm-st-field-group");
  secretWrap.appendChild(makeEl(doc, "label", undefined, text("secrets", "Server Secrets (/api/secrets/write)")));
  const slotSelect = makeSelect(
    "vm_st_secret_slot",
    [
      ["openaiTts", text("secret_openai", "OpenAI-Compatible TTS Key")],
      ["mimo", text("secret_mimo", "MiMo TTS Key")],
      ["asr", text("secret_asr", "OpenAI-Compatible ASR Key")],
      ["daemon", text("secret_daemon", "Local Voice Daemon Token")],
    ],
    "openaiTts",
  );
  const secretInput = makeInput("vm_st_secret_input", "password", text("paste_secret", "Paste secret key"));
  secretInput.autocomplete = "off";
  const saveKeyBtn = makeEl(doc, "button", "menu_button", text("save_secret", "Save Server Secret"));
  saveKeyBtn.type = "button";
  saveKeyBtn.id = "vm_st_save_secret_btn";
  saveKeyBtn.addEventListener("click", () => {
    const slot = slotSelect.value as SecretSlot;
    const value = secretInput.value;
    secretInput.value = "";
    saveKeyBtn.disabled = true;
    void options.saveSecret(slot, value).finally(() => {
      saveKeyBtn.disabled = false;
    });
  });
  secretWrap.append(slotSelect, secretInput, saveKeyBtn);
  content.appendChild(secretWrap);

  const actions = makeEl(doc, "div", "vm-st-actions");
  const dictateBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("dictate", "Dictate Mic"),
  ) as HTMLButtonElement;
  dictateBtn.type = "button";
  dictateBtn.id = "vm_st_dictate_btn";
  dictateBtn.disabled = !originStatus.secure;
  dictateBtn.addEventListener("click", options.toggleDictation);

  const bargeBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("barge", "Stop / Barge-In"),
  ) as HTMLButtonElement;
  bargeBtn.type = "button";
  bargeBtn.id = "vm_st_barge_in_btn";
  bargeBtn.addEventListener("click", options.triggerBargeIn);

  const exportBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("export_wav", "Export last reply as WAV"),
  ) as HTMLButtonElement;
  exportBtn.type = "button";
  exportBtn.id = "vm_st_export_wav_btn";
  let exportInProgress = false;
  exportBtn.addEventListener("click", () => {
    if (exportInProgress) return;
    exportInProgress = true;
    void (async () => {
      statusBadgeEl.textContent = text("exporting", "Exporting…");
      try {
        const result = await options.exportLastReplyAsWav();
        if (!result.wav) {
          statusBadgeEl.textContent =
            result.reason === "empty"
              ? text("export_empty", "No reply to export.")
              : text(
                  "export_no_wav",
                  "Current TTS engine cannot export WAV; the local voice-daemon or a WAV-capable engine is required.",
                );
          return;
        }
        try {
          const wavBuffer = result.wav.buffer.slice(
            result.wav.byteOffset,
            result.wav.byteOffset + result.wav.byteLength,
          ) as ArrayBuffer;
          const url = URL.createObjectURL(new Blob([wavBuffer], { type: "audio/wav" }));
          const link = doc.createElement("a");
          link.href = url;
          link.download = `voice-mode-${Date.now()}.wav`;
          link.click();
          URL.revokeObjectURL(url);
        } catch {
          // Download API unavailable (e.g. test DOM): the export itself still succeeded.
        }
        statusBadgeEl.textContent = text("export_done", "Exported {0} sentences to WAV.", String(result.sentences));
      } catch {
        statusBadgeEl.textContent = text("export_failed", "Export failed. Check the console and retry.");
      } finally {
        exportInProgress = false;
      }
    })();
  });

  const diagBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("copy_diagnostics", "Copy diagnostics"),
  ) as HTMLButtonElement;
  diagBtn.type = "button";
  diagBtn.id = "vm_st_copy_diagnostics_btn";
  diagBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const payload = JSON.stringify(options.getDiagnostics(), null, 2);
        const nav = (doc.defaultView as (Window & typeof globalThis) | null)?.navigator;
        const clipboard = nav?.clipboard;
        if (!clipboard?.writeText) throw new Error("clipboard unavailable");
        await clipboard.writeText(payload);
        statusBadgeEl.textContent = text("diagnostics_copied", "Diagnostics copied to clipboard.");
      } catch {
        statusBadgeEl.textContent = text(
          "diagnostics_copy_failed",
          "Could not copy diagnostics (clipboard unavailable).",
        );
      }
    })();
  });

  actions.append(dictateBtn, bargeBtn, exportBtn, diagBtn);
  content.appendChild(actions);

  root.append(header, content);
  hostContainer.appendChild(root);
  return {
    root,
    refreshCharacter,
    showOriginStatus,
    setStatus(message: string) {
      statusBadgeEl.textContent = message;
    },
    setDictationState(state: DictationSessionState) {
      dictateBtn.textContent = state === "idle"
        ? text("dictate", "Dictate Mic")
        : text("stop_dictation", "Stop Dictation");
    },
  };
}
