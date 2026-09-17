export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Looks up a dispatch table entry by an untrusted, wire-supplied key. Plain object literals inherit
 * from `Object.prototype`, so keys such as `toString` or `constructor` would otherwise resolve to
 * inherited members and be invoked.
 */
export function lookupDispatchEntry<TEntry>(
  table: Readonly<Partial<Record<string, TEntry>>>,
  key: string,
): TEntry | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readCoercedFiniteNumber(value: unknown): number | null {
  return readFiniteNumber(typeof value === 'string' ? Number(value) : value);
}

export function readFiniteNumberLike(value: unknown): number | null {
  return typeof value === 'string' && !value.trim() ? null : readCoercedFiniteNumber(value);
}

export function readIntegerLike(value: unknown): number | null {
  const number = readFiniteNumberLike(value);
  return number === null ? null : Math.trunc(number);
}

export function readNonNegativeIntegerLike(value: unknown): number | null {
  const number = readFiniteNumberLike(value);
  return number === null ? null : Math.max(0, Math.floor(number));
}

export function readTrimmedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
}

export function readNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : null;
}
