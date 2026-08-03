export type CompactDiffLineKind = 'context' | 'add' | 'remove';

export interface CompactDiffLine {
  kind: CompactDiffLineKind;
  prefix: ' ' | '+' | '-';
  content: string;
}

export interface CompactDiff {
  lines: CompactDiffLine[];
  additions: number;
  deletions: number;
  omittedChangedLines: number;
  unavailable: boolean;
}

const CONTEXT_LINES = 3;
const MAX_RENDERED_CHANGED_LINES = 40;
const ACP_STRUCTURED_STRING_LIMIT = 16 * 1024;
const TRUNCATION_GUARD_BYTES = 8;

export function buildCompactDiff(oldText: string | null, newText: string): CompactDiff {
  if (looksStructurallyTruncated(oldText) || looksStructurallyTruncated(newText)) {
    return unavailableDiff();
  }

  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);
  const prefixLength = commonPrefixLength(oldLines, newLines);
  const suffixLength = commonSuffixLength(oldLines, newLines, prefixLength);
  const oldChanged = oldLines.slice(prefixLength, oldLines.length - suffixLength);
  const newChanged = newLines.slice(prefixLength, newLines.length - suffixLength);
  if (oldChanged.length === 0 && newChanged.length === 0) {
    return {
      lines: [],
      additions: 0,
      deletions: 0,
      omittedChangedLines: 0,
      unavailable: false,
    };
  }
  const shownChangedLines = boundChangedLines(oldChanged, newChanged);
  const before = oldLines.slice(Math.max(0, prefixLength - CONTEXT_LINES), prefixLength);
  const afterStart = newLines.length - suffixLength;
  const after = newLines.slice(afterStart, Math.min(newLines.length, afterStart + CONTEXT_LINES));

  return {
    lines: [
      ...before.map((content) => line('context', ' ', content)),
      ...shownChangedLines,
      ...after.map((content) => line('context', ' ', content)),
    ],
    additions: newChanged.length,
    deletions: oldChanged.length,
    omittedChangedLines: Math.max(
      0,
      oldChanged.length + newChanged.length - shownChangedLines.length,
    ),
    unavailable: false,
  };
}

function boundChangedLines(oldChanged: string[], newChanged: string[]): CompactDiffLine[] {
  let removalLimit = Math.min(oldChanged.length, Math.ceil(MAX_RENDERED_CHANGED_LINES / 2));
  let additionLimit = Math.min(newChanged.length, MAX_RENDERED_CHANGED_LINES - removalLimit);
  removalLimit = Math.min(oldChanged.length, MAX_RENDERED_CHANGED_LINES - additionLimit);
  additionLimit = Math.min(newChanged.length, MAX_RENDERED_CHANGED_LINES - removalLimit);
  return [
    ...oldChanged.slice(0, removalLimit).map((content) => line('remove', '-', content)),
    ...newChanged.slice(0, additionLimit).map((content) => line('add', '+', content)),
  ];
}

function commonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string[], right: string[], prefixLength: number): number {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let count = 0;
  while (count < limit && left[left.length - 1 - count] === right[right.length - 1 - count]) {
    count += 1;
  }
  return count;
}

function splitLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function looksStructurallyTruncated(value: string | null): boolean {
  return value !== null && value.length >= ACP_STRUCTURED_STRING_LIMIT - TRUNCATION_GUARD_BYTES;
}

function line(
  kind: CompactDiffLineKind,
  prefix: CompactDiffLine['prefix'],
  content: string,
): CompactDiffLine {
  return { kind, prefix, content };
}

function unavailableDiff(): CompactDiff {
  return {
    lines: [],
    additions: 0,
    deletions: 0,
    omittedChangedLines: 0,
    unavailable: true,
  };
}
