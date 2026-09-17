import {
  readBoolean,
  readCoercedFiniteNumber,
  readFiniteNumber,
  readFiniteNumberLike,
  readIntegerLike,
  readNonEmptyStringArray,
  readNonNegativeIntegerLike,
  readString,
  readTrimmedStringArray,
  toRecord,
} from '@shared/runtimeValidation';

describe('runtimeValidation', () => {
  it('accepts records but rejects arrays and null', () => {
    expect(toRecord({ id: 'thread-1' })).toEqual({ id: 'thread-1' });
    expect(toRecord([['id', 'thread-1']])).toBeNull();
    expect(toRecord(null)).toBeNull();
  });

  it('preserves record identity and accepts objects without a prototype', () => {
    const record: Record<string, unknown> = Object.create(null);
    record['id'] = 'thread-1';
    expect(toRecord(record)).toBe(record);
  });

  it('does not coerce strings or booleans', () => {
    expect(readString('')).toBe('');
    expect(readString(' text ')).toBe(' text ');
    expect(readString(42)).toBeNull();
    expect(readBoolean(false)).toBe(false);
    expect(readBoolean(true)).toBe(true);
    expect(readBoolean('false')).toBeNull();
    expect(readBoolean(0)).toBeNull();
  });

  it('keeps strict and coercing finite-number policies explicit', () => {
    expect(readFiniteNumber(3.7)).toBe(3.7);
    expect(readFiniteNumber('42')).toBeNull();
    expect(readFiniteNumberLike(3.7)).toBe(3.7);
    expect(readFiniteNumberLike(' 42 ')).toBe(42);
    expect(readFiniteNumberLike('')).toBeNull();
    expect(readFiniteNumberLike(Number.POSITIVE_INFINITY)).toBeNull();
    expect(readCoercedFiniteNumber('')).toBe(0);
    expect(readCoercedFiniteNumber('   ')).toBe(0);
    expect(readCoercedFiniteNumber('42')).toBe(42);
    expect(readFiniteNumberLike(' \t\n ')).toBeNull();
    expect(readFiniteNumberLike('0x10')).toBe(16);
    expect(readFiniteNumberLike('1e2')).toBe(100);
  });

  it.each([undefined, null, false, [], {}, NaN, Infinity, -Infinity, 'bad', 'Infinity'])(
    'rejects %p in every numeric reader',
    (value) => {
      for (const read of [
        readFiniteNumber,
        readCoercedFiniteNumber,
        readFiniteNumberLike,
        readIntegerLike,
        readNonNegativeIntegerLike,
      ]) {
        expect(read(value)).toBeNull();
      }
    },
  );

  it('makes integer rounding policy explicit', () => {
    expect(readIntegerLike(3.7)).toBe(3);
    expect(readIntegerLike('-2.8')).toBe(-2);
    expect(readNonNegativeIntegerLike(3.7)).toBe(3);
    expect(readNonNegativeIntegerLike('-2.8')).toBe(0);
    expect(readIntegerLike('-0.5')).toBe(-0);
  });

  it('keeps normalized and presence-based string-array policies explicit', () => {
    expect(readTrimmedStringArray([' a ', '', 2, 'b'])).toEqual(['a', 'b']);
    expect(readTrimmedStringArray('a')).toEqual([]);
    expect(readNonEmptyStringArray([' a ', '', 2, 'b'])).toEqual([' a ', '', 'b']);
    expect(readNonEmptyStringArray([])).toBeNull();
    expect(readNonEmptyStringArray('a')).toBeNull();
    expect(readNonEmptyStringArray([''])).toEqual(['']);
    expect(readNonEmptyStringArray([null, false, 2])).toBeNull();
  });

  it('returns new arrays without mutating the input', () => {
    const input = Object.freeze([' a ', '', 'b']);
    expect(readTrimmedStringArray(input)).toEqual(['a', 'b']);
    const strings = readNonEmptyStringArray(input);
    expect(strings).toEqual(input);
    expect(strings).not.toBe(input);
  });
});
