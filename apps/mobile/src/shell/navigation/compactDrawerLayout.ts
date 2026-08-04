export function resolveCompactDrawerWidth(viewportWidth: number): number {
  return Math.min(viewportWidth, 360, Math.max(280, viewportWidth - 48));
}
