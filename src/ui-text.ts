export type HostTranslate = (fallback: string, key: string) => string;

export type UiText = (key: string, fallback: string, ...values: string[]) => string;

export function createUiText(translate?: HostTranslate): UiText {
  return (key, fallback, ...values) => {
    const message = translate?.(fallback, `voice_mode.${key}`) || fallback;
    if (!values.length) return message;
    return message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
      values[Number(index)] ?? placeholder,
    );
  };
}
