import {
  DEFAULT_ASR_OPENAI_BASE_URL,
  DEFAULT_ASR_OPENAI_MODEL,
  DEFAULT_DAEMON_BASE_URL,
  MIMO_DEFAULT_BASE_URL,
  MIMO_DEFAULT_MODEL,
  MIMO_DEFAULT_VOICE,
  redactSecrets,
  validateReplacements,
  type AsrReplacement,
} from "@voice-mode/core";
import type { BargeInMode } from "@voice-mode/browser";

export const EXTENSION_KEY = "voice_mode";
export const EXTENSION_VERSION = "0.1.0";
export const EMOTION_PROMPT_KEY = "sillytavern-voice-mode-emotion";

export type StTtsEngineKind = "system" | "openai-compat" | "mimo" | "kokoro-daemon";
export type StAsrEngineKind = "system" | "openai-compat" | "daemon";

export interface VoiceAssignment {
  engine: StTtsEngineKind;
  voice: string;
  presetId?: string;
  rate?: number;
}

export interface VoiceModeExtensionSettings {
  enabled: boolean;
  emotionPromptEnabled: boolean;
  narrationSplitEnabled: boolean;
  bargeInMode: BargeInMode;
  autoSendOnDictation: boolean;
  useServerPluginProxy: boolean;
  defaultVoice: VoiceAssignment;
  narratorVoice: VoiceAssignment;
  voiceMap: Record<string, VoiceAssignment>;
  openaiTtsPresetId: string;
  openaiTtsBaseUrl: string;
  openaiTtsModel: string;
  mimoBaseUrl: string;
  mimoModel: string;
  daemonBaseUrl: string;
  asrEngine: StAsrEngineKind;
  asrLanguage: string;
  asrBaseUrl: string;
  asrModel: string;
  asrReplacements: AsrReplacement[];
}

export const DEFAULT_VOICE_ASSIGNMENT: Readonly<VoiceAssignment> = Object.freeze({
  engine: "system",
  voice: "",
});

export const DEFAULT_SETTINGS: Readonly<VoiceModeExtensionSettings> =
  Object.freeze<VoiceModeExtensionSettings>({
  enabled: true,
  emotionPromptEnabled: false,
  narrationSplitEnabled: true,
  bargeInMode: "detect",
  autoSendOnDictation: false,
  useServerPluginProxy: false,
  defaultVoice: { engine: "system", voice: "" },
  narratorVoice: { engine: "system", voice: "" },
  voiceMap: {},
  openaiTtsPresetId: "openai",
  openaiTtsBaseUrl: "https://api.openai.com/v1",
  openaiTtsModel: "gpt-4o-mini-tts",
  mimoBaseUrl: MIMO_DEFAULT_BASE_URL,
  mimoModel: MIMO_DEFAULT_MODEL,
  daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
  asrEngine: "system",
  asrLanguage: "auto",
  asrBaseUrl: DEFAULT_ASR_OPENAI_BASE_URL,
  asrModel: DEFAULT_ASR_OPENAI_MODEL,
  asrReplacements: [],
});

export type SecretSlot = "openaiTts" | "mimo" | "asr" | "daemon";

export const SECRET_SLOT_KEYS: Readonly<Record<SecretSlot, string>> = Object.freeze({
  openaiTts: "api_key_custom_openai_tts",
  mimo: "voice_mode_mimo_api_key",
  asr: "voice_mode_asr_api_key",
  daemon: "voice_mode_daemon_token",
});

const VALID_TTS_ENGINES = new Set<StTtsEngineKind>([
  "system",
  "openai-compat",
  "mimo",
  "kokoro-daemon",
]);
const VALID_ASR_ENGINES = new Set<StAsrEngineKind>(["system", "openai-compat", "daemon"]);
const VALID_BARGE_IN_MODES = new Set<BargeInMode>(["detect", "auto", "manual"]);

function sanitizeCleanString(val: unknown, fallback = ""): string {
  if (typeof val !== "string") return fallback;
  const trimmed = val.trim();
  if (trimmed.length > 0 && redactSecrets(trimmed) !== trimmed) {
    return fallback;
  }
  return trimmed;
}

export function normalizeVoiceAssignment(
  raw: unknown,
  fallbackEngine: StTtsEngineKind = "system",
): VoiceAssignment {
  if (typeof raw === "string") {
    const voice = sanitizeCleanString(raw, "");
    return { engine: fallbackEngine, voice };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      engine: fallbackEngine,
      voice: fallbackEngine === "mimo" ? MIMO_DEFAULT_VOICE : "",
    };
  }
  const obj = raw as Record<string, unknown>;
  const engine = VALID_TTS_ENGINES.has(obj.engine as StTtsEngineKind)
    ? (obj.engine as StTtsEngineKind)
    : fallbackEngine;
  const voice = sanitizeCleanString(
    obj.voice,
    engine === "mimo" ? MIMO_DEFAULT_VOICE : "",
  );
  const out: VoiceAssignment = { engine, voice };
  const presetId = sanitizeCleanString(obj.presetId, "");
  if (presetId) out.presetId = presetId;
  if (typeof obj.rate === "number" && Number.isFinite(obj.rate) && obj.rate > 0) {
    out.rate = Math.min(3, Math.max(0.25, obj.rate));
  }
  return out;
}

/**
 * Normalize and write back `extension_settings.voice_mode` with an explicit allowlist of fields
 * so plaintext API keys or bearer tokens can never reside in SillyTavern's `settings.json`.
 */
export function ensureExtensionSettings(
  store: Record<string, unknown>,
): VoiceModeExtensionSettings {
  const raw = store[EXTENSION_KEY];
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const defaultVoice = normalizeVoiceAssignment(src.defaultVoice, "system");
  const narratorVoice = normalizeVoiceAssignment(
    src.narratorVoice,
    defaultVoice.engine,
  );

  const voiceMap: Record<string, VoiceAssignment> = {};
  if (src.voiceMap && typeof src.voiceMap === "object" && !Array.isArray(src.voiceMap)) {
    for (const [speakerKey, entry] of Object.entries(
      src.voiceMap as Record<string, unknown>,
    )) {
      const cleanKey = speakerKey.trim();
      if (!cleanKey) continue;
      voiceMap[cleanKey] = normalizeVoiceAssignment(entry, defaultVoice.engine);
    }
  }

  const repValidation = validateReplacements(src.asrReplacements);
  const asrReplacements = repValidation.ok ? repValidation.rules : [];

  const merged: VoiceModeExtensionSettings = {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_SETTINGS.enabled,
    emotionPromptEnabled:
      typeof src.emotionPromptEnabled === "boolean"
        ? src.emotionPromptEnabled
        : DEFAULT_SETTINGS.emotionPromptEnabled,
    narrationSplitEnabled:
      typeof src.narrationSplitEnabled === "boolean"
        ? src.narrationSplitEnabled
        : DEFAULT_SETTINGS.narrationSplitEnabled,
    bargeInMode: VALID_BARGE_IN_MODES.has(src.bargeInMode as BargeInMode)
      ? (src.bargeInMode as BargeInMode)
      : DEFAULT_SETTINGS.bargeInMode,
    autoSendOnDictation:
      typeof src.autoSendOnDictation === "boolean"
        ? src.autoSendOnDictation
        : DEFAULT_SETTINGS.autoSendOnDictation,
    useServerPluginProxy:
      typeof src.useServerPluginProxy === "boolean"
        ? src.useServerPluginProxy
        : DEFAULT_SETTINGS.useServerPluginProxy,
    defaultVoice,
    narratorVoice,
    voiceMap,
    openaiTtsPresetId: sanitizeCleanString(
      src.openaiTtsPresetId,
      DEFAULT_SETTINGS.openaiTtsPresetId,
    ),
    openaiTtsBaseUrl: sanitizeCleanString(
      src.openaiTtsBaseUrl,
      DEFAULT_SETTINGS.openaiTtsBaseUrl,
    ),
    openaiTtsModel: sanitizeCleanString(
      src.openaiTtsModel,
      DEFAULT_SETTINGS.openaiTtsModel,
    ),
    mimoBaseUrl: sanitizeCleanString(src.mimoBaseUrl, DEFAULT_SETTINGS.mimoBaseUrl),
    mimoModel: sanitizeCleanString(src.mimoModel, DEFAULT_SETTINGS.mimoModel),
    daemonBaseUrl: sanitizeCleanString(
      src.daemonBaseUrl,
      DEFAULT_SETTINGS.daemonBaseUrl,
    ),
    asrEngine: VALID_ASR_ENGINES.has(src.asrEngine as StAsrEngineKind)
      ? (src.asrEngine as StAsrEngineKind)
      : DEFAULT_SETTINGS.asrEngine,
    asrLanguage: sanitizeCleanString(src.asrLanguage, DEFAULT_SETTINGS.asrLanguage),
    asrBaseUrl: sanitizeCleanString(src.asrBaseUrl, DEFAULT_SETTINGS.asrBaseUrl),
    asrModel: sanitizeCleanString(src.asrModel, DEFAULT_SETTINGS.asrModel),
    asrReplacements,
  };

  store[EXTENSION_KEY] = merged;
  return merged;
}

export interface HostSecretsAdapter {
  writeSecret(
    key: string,
    value: string,
    label?: string,
  ): Promise<string | null>;
  findSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
  canViewSecrets?: () => Promise<boolean | null>;
  hasRemoteSecret?: (key: string) => boolean;
}

/**
 * Stores API keys in server-side `secrets.json` (`/api/secrets/write`) plus an ephemeral
 * in-memory cache for the active tab session (needed when `allowKeysExposure: false` on ST).
 * Never writes credentials to `extension_settings` or `localStorage`.
 */
export class SillyTavernSecretBroker {
  private readonly ephemeral = new Map<SecretSlot, string>();
  private readonly host: HostSecretsAdapter;
  private canViewCached: boolean | null | undefined = undefined;

  constructor(host: HostSecretsAdapter) {
    this.host = host;
  }

  async setSecret(slot: SecretSlot, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.deleteSecret(slot);
      return;
    }
    this.ephemeral.set(slot, trimmed);
    await this.host.writeSecret(
      SECRET_SLOT_KEYS[slot],
      trimmed,
      `Voice Mode (${slot})`,
    );
  }

  async getSecret(slot: SecretSlot): Promise<string | null> {
    const mem = this.ephemeral.get(slot);
    if (mem) return mem;
    const secretKey = SECRET_SLOT_KEYS[slot];
    if (this.host.hasRemoteSecret && !this.host.hasRemoteSecret(secretKey)) {
      return null;
    }
    if (this.host.canViewSecrets) {
      if (this.canViewCached === undefined) {
        this.canViewCached = await this.host.canViewSecrets();
      }
      if (this.canViewCached !== true) {
        return null;
      }
    }
    const remote = await this.host.findSecret(secretKey);
    if (typeof remote === "string" && remote.trim()) {
      const clean = remote.trim();
      this.ephemeral.set(slot, clean);
      return clean;
    }
    return null;
  }

  async deleteSecret(slot: SecretSlot): Promise<void> {
    this.ephemeral.delete(slot);
    await this.host.deleteSecret(SECRET_SLOT_KEYS[slot]);
  }

  knownSecretsSnapshot(): string[] {
    return Array.from(this.ephemeral.values());
  }
}

export interface SecureOriginStatus {
  secure: boolean;
  originLabel: string;
  remediation: string;
}

export interface WindowOriginLike {
  isSecureContext?: boolean;
  location?: {
    protocol?: string;
    hostname?: string;
    host?: string;
  };
}

export function inspectSecureOrigin(win?: WindowOriginLike | null): SecureOriginStatus {
  const host = win?.location?.host ?? "unknown-host";
  const protocol = win?.location?.protocol ?? "http:";
  const originLabel = `${protocol}//${host}`;
  if (Boolean(win && win.isSecureContext === true)) {
    return {
      secure: true,
      originLabel,
      remediation: "",
    };
  }
  return {
    secure: false,
    originLabel,
    remediation:
      `Microphone access is blocked on non-secure origin ${originLabel}. ` +
      `Open SillyTavern via http://127.0.0.1 or http://localhost, forward the port over SSH ` +
      `(ssh -L 8000:127.0.0.1:8000), or enable HTTPS (ssl.enabled: true in config.yaml / reverse proxy / Tailscale HTTPS).`,
  };
}

export function formatSafeError(err: unknown, knownSecrets: readonly string[] = []): string {
  const raw = err instanceof Error ? err.message : String(err);
  let safe = redactSecrets(raw);
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4 && safe.includes(secret)) {
      safe = safe.split(secret).join("[REDACTED]");
    }
  }
  return safe.slice(0, 280);
}
