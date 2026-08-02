export function requireTestValue<T>(value: T | undefined, label = 'test value'): T {
  if (value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}
