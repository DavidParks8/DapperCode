export interface CalleeDisplay {
  /** Primary headline: contact/business name when known, otherwise formatted phone number. */
  displayName: string;
  /** Contact or business name, when known. */
  name: string | null;
  /** Human-readable phone number, when present. */
  formattedNumber: string | null;
  /** Raw phone number from the bridge, when present. */
  rawNumber: string | null;
}

const NAMED_NUMBER_PATTERN = /^(.+?)\s*\((\+?[0-9][0-9\s().-]{5,})\)$/;
const RAW_PHONE_PATTERN = /^\+?[0-9][0-9\s().-]{6,}$/;

/** Formats NANP phone numbers for human scanning and preserves international E.164 numbers intact. */
export function formatPhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !RAW_PHONE_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (!hasPlus && digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return trimmed;
}

/** Splits a bridge callee string such as `"CVS Pharmacy (+15551234567)"` into name + formatted number. */
export function parseCalleeDisplay(raw: string): CalleeDisplay {
  const trimmed = raw.trim();
  const named = NAMED_NUMBER_PATTERN.exec(trimmed);
  if (named) {
    const name = (named[1] ?? '').trim();
    const rawNumber = (named[2] ?? '').trim();
    const formattedNumber = formatPhoneNumber(rawNumber);
    return {
      displayName: name || formattedNumber,
      name: name || null,
      formattedNumber,
      rawNumber,
    };
  }
  if (RAW_PHONE_PATTERN.test(trimmed)) {
    const formattedNumber = formatPhoneNumber(trimmed);
    return {
      displayName: formattedNumber,
      name: null,
      formattedNumber,
      rawNumber: trimmed,
    };
  }
  return {
    displayName: trimmed || 'Phone call',
    name: trimmed || null,
    formattedNumber: null,
    rawNumber: null,
  };
}
