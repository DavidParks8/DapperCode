import { isRecord } from '@shared/records';

export class LocalToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalToolInputError';
  }
}

export function argumentsRecord(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new LocalToolInputError('Tool arguments must be a JSON object.');
  }
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new LocalToolInputError('The tool received unsupported arguments.');
  }
  return input;
}

export function text(
  record: Record<string, unknown>,
  key: string,
  maximum = 4096,
  minimum = 1,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new LocalToolInputError(
      `Tool argument "${key}" must be text of length ${minimum}-${maximum}.`,
    );
  }
  return value;
}

export function integer(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new LocalToolInputError(
      `Tool argument "${key}" must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

export function expectedRevision(record: Record<string, unknown>, required = false): string | null {
  const value = record['expected_revision'];
  if (!required && (value === undefined || value === null)) {
    return null;
  }
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new LocalToolInputError('Use the revision returned by read_file before changing a file.');
  }
  return value;
}
