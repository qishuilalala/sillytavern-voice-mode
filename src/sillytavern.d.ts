declare module "sillytavern/script" {
  export interface SillyTavernEventSource {
    on(event: string, listener: (...args: unknown[]) => unknown): void;
    once(event: string, listener: (...args: unknown[]) => unknown): void;
    makeLast(event: string, listener: (...args: unknown[]) => unknown): void;
    removeListener(event: string, listener: (...args: unknown[]) => unknown): void;
    emit(event: string, ...args: unknown[]): Promise<void>;
  }

  export const eventSource: SillyTavernEventSource;
  export const event_types: {
    readonly APP_INITIALIZED: "app_initialized";
    readonly APP_READY: "app_ready";
    readonly CHAT_CHANGED: "chat_id_changed";
    readonly GENERATION_STARTED: "generation_started";
    readonly GENERATION_STOPPED: "generation_stopped";
    readonly GENERATION_ENDED: "generation_ended";
    readonly STREAM_TOKEN_RECEIVED: "stream_token_received";
    readonly CHARACTER_MESSAGE_RENDERED: "character_message_rendered";
    readonly USER_MESSAGE_RENDERED: "user_message_rendered";
    readonly MESSAGE_SWIPED: "message_swiped";
    readonly MESSAGE_DELETED: "message_deleted";
    readonly GROUP_UPDATED: "group_updated";
    readonly SECRET_WRITTEN: "secret_written";
    readonly SECRET_DELETED: "secret_deleted";
    readonly SECRET_ROTATED: "secret_rotated";
    readonly [key: string]: string;
  };

  export const extension_prompt_types: {
    readonly NONE: -1;
    readonly IN_PROMPT: 0;
    readonly IN_CHAT: 1;
    readonly BEFORE_PROMPT: 2;
  };

  export const extension_prompt_roles: {
    readonly SYSTEM: 0;
    readonly USER: 1;
    readonly ASSISTANT: 2;
  };

  export function saveSettingsDebounced(): void;
  export function stopGeneration(): boolean;
  export function isGenerating(): boolean;
  export function getCurrentChatId(): string | undefined;
  export function getRequestHeaders(options?: { omitContentType?: boolean }): Record<string, string>;
  export function substituteParams(text: string): string;
  export function setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: (() => boolean | Promise<boolean>) | null,
  ): void;
}

declare module "sillytavern/extensions" {
  export interface SillyTavernChatMessage {
    name: string;
    is_user: boolean;
    is_system?: boolean;
    mes: string;
    swipe_id?: number;
    original_avatar?: string;
    extra?: Record<string, unknown>;
  }

  export interface SillyTavernCharacter {
    name: string;
    avatar: string;
    chat?: string;
    data?: {
      extensions?: Record<string, unknown>;
    };
  }

  export interface SillyTavernGroup {
    id: string;
    name: string;
    chat_id?: string;
    members: string[];
  }

  export interface SillyTavernContext {
    chat: SillyTavernChatMessage[];
    characters: SillyTavernCharacter[];
    groups: SillyTavernGroup[];
    name1: string;
    name2: string;
    characterId: number | undefined;
    groupId: string | null;
    chatId: string | undefined;
    streamingProcessor: {
      isFinished: boolean;
      isStopped: boolean;
    } | null;
    extensionSettings: Record<string, unknown>;
    saveSettingsDebounced: () => void;
    stopGeneration: () => boolean;
    setExtensionPrompt: (
      key: string,
      value: string,
      position: number,
      depth: number,
      scan?: boolean,
      role?: number,
      filter?: (() => boolean | Promise<boolean>) | null,
    ) => void;
  }

  export const extension_settings: Record<string, unknown>;
  export function getContext(): SillyTavernContext;
  export function renderExtensionTemplateAsync(
    extensionName: string,
    templateId: string,
    templateData?: Record<string, unknown>,
    sanitize?: boolean,
    localize?: boolean,
  ): Promise<string>;
  export function writeExtensionField(
    characterId: number | string,
    key: string,
    value: unknown,
  ): Promise<void>;
  export const UNSET_VALUE: string;
}

declare module "sillytavern/secrets" {
  export const SECRET_KEYS: Record<string, string>;
  export const secret_state: Record<string, unknown>;
  export function writeSecret(
    key: string,
    value: string,
    label?: string,
    options?: { allowEmpty?: boolean },
  ): Promise<string | null>;
  export function deleteSecret(key: string, id?: string): Promise<void>;
  export function readSecretState(): Promise<void>;
  export function findSecret(key: string, id?: string): Promise<string | null>;
}
