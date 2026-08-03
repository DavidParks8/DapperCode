export function resolveKeyboardInset(
  screenHeight: number,
  keyboardTop: number | undefined,
  keyboardHeight: number | undefined,
): number {
  const normalizedScreenHeight = Number.isFinite(screenHeight) ? Math.max(0, screenHeight) : 0;
  if (typeof keyboardTop === 'number' && Number.isFinite(keyboardTop)) {
    return Math.max(0, normalizedScreenHeight - keyboardTop);
  }
  return typeof keyboardHeight === 'number' && Number.isFinite(keyboardHeight)
    ? Math.max(0, keyboardHeight)
    : 0;
}
