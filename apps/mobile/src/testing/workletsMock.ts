export function scheduleOnRN<Args extends unknown[]>(
  callback: (...args: Args) => unknown,
  ...args: Args
): void {
  callback(...args);
}
