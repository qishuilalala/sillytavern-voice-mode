// src/index.ts
import { saveSettingsDebounced } from "../../../../../script.js";
import { extension_settings, getContext } from "../../../../extensions.js";
var EXTENSION_KEY = "voice_mode";
var EXTENSION_VERSION = "0.1.0";
var DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  emotionPromptEnabled: false,
  voiceMap: {}
});
var activated = false;
function ensureExtensionSettings(store = extension_settings) {
  const raw = store[EXTENSION_KEY];
  const existing = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const merged = {
    enabled: typeof existing.enabled === "boolean" ? existing.enabled : DEFAULT_SETTINGS.enabled,
    emotionPromptEnabled: typeof existing.emotionPromptEnabled === "boolean" ? existing.emotionPromptEnabled : DEFAULT_SETTINGS.emotionPromptEnabled,
    voiceMap: existing.voiceMap && typeof existing.voiceMap === "object" && !Array.isArray(existing.voiceMap) ? { ...existing.voiceMap } : {}
  };
  store[EXTENSION_KEY] = merged;
  return merged;
}
async function activate() {
  if (activated) {
    return;
  }
  activated = true;
  ensureExtensionSettings(extension_settings);
  void getContext();
  saveSettingsDebounced();
}
export {
  DEFAULT_SETTINGS,
  EXTENSION_KEY,
  EXTENSION_VERSION,
  activate,
  ensureExtensionSettings
};
