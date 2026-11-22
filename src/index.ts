import { saveSettingsDebounced } from "sillytavern/script";
import { extension_settings, getContext } from "sillytavern/extensions";

export const EXTENSION_KEY = "voice_mode";
export const EXTENSION_VERSION = "0.1.0";

export interface VoiceModeExtensionSettings {
  enabled: boolean;
  emotionPromptEnabled: boolean;
  voiceMap: Record<string, string>;
}

export const DEFAULT_SETTINGS: Readonly<VoiceModeExtensionSettings> = Object.freeze({
  enabled: false,
  emotionPromptEnabled: false,
  voiceMap: {},
});

let activated = false;

export function ensureExtensionSettings(
  store: Record<string, unknown> = extension_settings,
): VoiceModeExtensionSettings {
  const raw = store[EXTENSION_KEY];
  const existing =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<VoiceModeExtensionSettings>)
      : {};
  const merged: VoiceModeExtensionSettings = {
    enabled: typeof existing.enabled === "boolean" ? existing.enabled : DEFAULT_SETTINGS.enabled,
    emotionPromptEnabled:
      typeof existing.emotionPromptEnabled === "boolean"
        ? existing.emotionPromptEnabled
        : DEFAULT_SETTINGS.emotionPromptEnabled,
    voiceMap:
      existing.voiceMap && typeof existing.voiceMap === "object" && !Array.isArray(existing.voiceMap)
        ? { ...(existing.voiceMap as Record<string, string>) }
        : {},
  };
  store[EXTENSION_KEY] = merged;
  return merged;
}

export async function activate(): Promise<void> {
  if (activated) {
    return;
  }
  activated = true;
  ensureExtensionSettings(extension_settings);
  void getContext();
  saveSettingsDebounced();
}
