import {
  eventSource,
  event_types,
  extension_prompt_roles,
  extension_prompt_types,
  getRequestHeaders,
  isGenerating,
  saveSettingsDebounced,
  setExtensionPrompt,
  stopGeneration,
} from "sillytavern/script";
import { extension_settings, getContext } from "sillytavern/extensions";
import {
  canViewSecrets,
  deleteSecret,
  findSecret,
  secret_state,
  writeSecret,
} from "sillytavern/secrets";

import {
  DEFAULT_SETTINGS,
  EMOTION_PROMPT_KEY,
  EXTENSION_KEY,
  EXTENSION_VERSION,
  ensureExtensionSettings,
  type VoiceModeExtensionSettings,
} from "./settings.ts";
import {
  createVoiceModeRuntime,
  type VoiceModeRuntime,
} from "./runtime.ts";

export {
  DEFAULT_SETTINGS,
  EMOTION_PROMPT_KEY,
  EXTENSION_KEY,
  EXTENSION_VERSION,
  ensureExtensionSettings,
  type VoiceModeExtensionSettings,
  type VoiceModeRuntime,
};

let activeRuntime: VoiceModeRuntime | null = null;

export function getVoiceModeRuntime(): VoiceModeRuntime | null {
  return activeRuntime;
}

export async function activate(): Promise<void> {
  if (!activeRuntime) {
    activeRuntime = createVoiceModeRuntime({
      eventSource,
      eventTypes: event_types,
      extensionPromptTypes: extension_prompt_types,
      extensionPromptRoles: extension_prompt_roles,
      extensionSettings: extension_settings,
      getContext,
      saveSettingsDebounced,
      isGenerating,
      stopGeneration,
      setExtensionPrompt,
      getRequestHeaders,
      secrets: {
        writeSecret: (key, value, label) => writeSecret(key, value, label),
        findSecret: (key) => findSecret(key),
        deleteSecret: (key) => deleteSecret(key),
        canViewSecrets: () => canViewSecrets(),
        hasRemoteSecret: (key) => {
          const val = secret_state[key];
          return Array.isArray(val) ? val.length > 0 : Boolean(val);
        },
      },
    });
  }
  await activeRuntime.activate();
}
