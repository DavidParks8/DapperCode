import {
  readCoercedFiniteNumber,
  readFiniteNumber,
  readFiniteNumberLike,
  readIntegerLike,
  readNonEmptyStringArray,
  readNonNegativeIntegerLike,
  readTrimmedStringArray,
  toRecord,
} from './runtimeValidation';

describe('runtimeValidation', () => {
  it('accepts records but rejects arrays and null', () => {
    expect(toRecord({ id: 'thread-1' })).toEqual({ id: 'thread-1' });
    expect(toRecord([['id', 'thread-1']])).toBeNull();
    expect(toRecord(null)).toBeNull();
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
  });

  it('makes integer rounding policy explicit', () => {
    expect(readIntegerLike(3.7)).toBe(3);
    expect(readIntegerLike('-2.8')).toBe(-2);
    expect(readNonNegativeIntegerLike(3.7)).toBe(3);
    expect(readNonNegativeIntegerLike('-2.8')).toBe(0);
  });

  it('keeps normalized and presence-based string-array policies explicit', () => {
    expect(readTrimmedStringArray([' a ', '', 2, 'b'])).toEqual(['a', 'b']);
    expect(readTrimmedStringArray('a')).toEqual([]);
    expect(readNonEmptyStringArray([' a ', '', 2, 'b'])).toEqual([' a ', '', 'b']);
    expect(readNonEmptyStringArray([])).toBeNull();
    expect(readNonEmptyStringArray('a')).toBeNull();
  });
});
