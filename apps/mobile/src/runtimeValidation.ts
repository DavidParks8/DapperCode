import * as v from 'valibot';

export const recordSchema = v.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);
export const stringSchema = v.string();
export const booleanSchema = v.boolean();
export const finiteNumberSchema = v.pipe(v.number(), v.finite());
export const coercedFiniteNumberSchema = v.union([
  finiteNumberSchema,
  v.pipe(v.string(), v.transform(Number), v.finite()),
]);
export const finiteNumberLikeSchema = v.union([
  finiteNumberSchema,
  v.pipe(v.string(), v.trim(), v.nonEmpty(), v.transform(Number), v.finite()),
]);
export const integerLikeSchema = v.pipe(
  finiteNumberLikeSchema,
  v.transform((value) => Math.trunc(value)),
);
export const nonNegativeIntegerLikeSchema = v.pipe(
  finiteNumberLikeSchema,
  v.transform((value) => Math.max(0, Math.floor(value))),
);

const unknownArraySchema = v.array(v.unknown());
export const trimmedStringArraySchema = v.pipe(
  unknownArraySchema,
  v.transform((values) =>
    values
      .map((value) => readString(value)?.trim() ?? '')
      .filter((value): value is string => value.length > 0),
  ),
);
export const nonEmptyStringArraySchema = v.pipe(
  unknownArraySchema,
  v.transform((values) => values.filter((value): value is string => readString(value) !== null)),
  v.nonEmpty(),
);

export function toRecord(value: unknown): Record<string, unknown> | null {
  const result = v.safeParse(recordSchema, value);
  return result.success ? result.output : null;
}

export function readString(value: unknown): string | null {
  const result = v.safeParse(stringSchema, value);
  return result.success ? result.output : null;
}

export function readBoolean(value: unknown): boolean | null {
  const result = v.safeParse(booleanSchema, value);
  return result.success ? result.output : null;
}

export function readFiniteNumber(value: unknown): number | null {
  const result = v.safeParse(finiteNumberSchema, value);
  return result.success ? result.output : null;
}

export function readCoercedFiniteNumber(value: unknown): number | null {
  const result = v.safeParse(coercedFiniteNumberSchema, value);
  return result.success ? result.output : null;
}

export function readFiniteNumberLike(value: unknown): number | null {
  const result = v.safeParse(finiteNumberLikeSchema, value);
  return result.success ? result.output : null;
}

export function readIntegerLike(value: unknown): number | null {
  const result = v.safeParse(integerLikeSchema, value);
  return result.success ? result.output : null;
}

export function readNonNegativeIntegerLike(value: unknown): number | null {
  const result = v.safeParse(nonNegativeIntegerLikeSchema, value);
  return result.success ? result.output : null;
}

export function readTrimmedStringArray(value: unknown): string[] {
  const result = v.safeParse(trimmedStringArraySchema, value);
  return result.success ? result.output : [];
}

export function readNonEmptyStringArray(value: unknown): string[] | null {
  const result = v.safeParse(nonEmptyStringArraySchema, value);
  return result.success ? result.output : null;
}
