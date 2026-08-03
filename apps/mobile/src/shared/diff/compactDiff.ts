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
const MAX_LCS_CELLS = 1_000_000;
const MAX_CACHE_ENTRIES = 64;
const ACP_STRUCTURED_STRING_LIMIT = 16 * 1024;
const TRUNCATION_GUARD_BYTES = 8;
const compactDiffCache = new Map<string | null, Map<string, CompactDiff>>();
const compactDiffCacheOrder: Array<readonly [string | null, string]> = [];

export function buildCompactDiff(oldText: string | null, newText: string): CompactDiff {
  const cached = compactDiffCache.get(oldText)?.get(newText);
  if (cached) {
    return cached;
  }
  const compact = computeCompactDiff(oldText, newText);
  cacheCompactDiff(oldText, newText, compact);
  return compact;
}

function computeCompactDiff(oldText: string | null, newText: string): CompactDiff {
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

  const operations = buildLineOperations(oldChanged, newChanged);
  if (!operations) {
    return unavailableDiff();
  }
  const additions = operations.filter((operation) => operation.kind === 'add').length;
  const deletions = operations.filter((operation) => operation.kind === 'remove').length;
  const shown = compactOperations(operations);
  const before = oldLines.slice(Math.max(0, prefixLength - CONTEXT_LINES), prefixLength);
  const afterStart = newLines.length - suffixLength;
  const after = newLines.slice(afterStart, Math.min(newLines.length, afterStart + CONTEXT_LINES));

  return {
    lines: [
      ...before.map((content) => line('context', ' ', content)),
      ...(shown.omittedBefore ? [line('context', ' ', '...')] : []),
      ...shown.lines,
      ...(shown.omittedAfter ? [line('context', ' ', '...')] : []),
      ...after.map((content) => line('context', ' ', content)),
    ],
    additions,
    deletions,
    omittedChangedLines: additions + deletions - shown.shownChangedLines,
    unavailable: false,
  };
}

function cacheCompactDiff(oldText: string | null, newText: string, compact: CompactDiff): void {
  let byNewText = compactDiffCache.get(oldText);
  if (!byNewText) {
    byNewText = new Map();
    compactDiffCache.set(oldText, byNewText);
  }
  byNewText.set(newText, compact);
  compactDiffCacheOrder.push([oldText, newText]);
  if (compactDiffCacheOrder.length <= MAX_CACHE_ENTRIES) {
    return;
  }
  const oldest = compactDiffCacheOrder.shift();
  if (!oldest) {
    return;
  }
  const [oldestOldText, oldestNewText] = oldest;
  const oldestByNewText = compactDiffCache.get(oldestOldText);
  oldestByNewText?.delete(oldestNewText);
  if (oldestByNewText?.size === 0) {
    compactDiffCache.delete(oldestOldText);
  }
}

function buildLineOperations(oldChanged: string[], newChanged: string[]): CompactDiffLine[] | null {
  const lengths = buildLcsMatrix(oldChanged, newChanged);
  return lengths ? walkLineOperations(oldChanged, newChanged, lengths) : null;
}

function buildLcsMatrix(oldChanged: string[], newChanged: string[]): Uint16Array[] | null {
  if ((oldChanged.length + 1) * (newChanged.length + 1) > MAX_LCS_CELLS) {
    return null;
  }
  const lengths = Array.from(
    { length: oldChanged.length + 1 },
    () => new Uint16Array(newChanged.length + 1),
  );
  for (let oldIndex = oldChanged.length - 1; oldIndex >= 0; oldIndex -= 1) {
    const row = lengths[oldIndex];
    const nextRow = lengths[oldIndex + 1];
    if (!row || !nextRow) {
      throw new Error('Invalid compact diff matrix row');
    }
    for (let newIndex = newChanged.length - 1; newIndex >= 0; newIndex -= 1) {
      row[newIndex] =
        oldChanged[oldIndex] === newChanged[newIndex]
          ? (nextRow[newIndex + 1] ?? 0) + 1
          : Math.max(nextRow[newIndex] ?? 0, row[newIndex + 1] ?? 0);
    }
  }
  return lengths;
}

function walkLineOperations(
  oldChanged: string[],
  newChanged: string[],
  lengths: Uint16Array[],
): CompactDiffLine[] {
  const operations: CompactDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldChanged.length || newIndex < newChanged.length) {
    const oldLine = oldChanged[oldIndex];
    const newLine = newChanged[newIndex];
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      operations.push(line('context', ' ', oldLine));
      oldIndex += 1;
      newIndex += 1;
    } else if (
      oldLine !== undefined &&
      (newLine === undefined ||
        (lengths[oldIndex + 1]?.[newIndex] ?? 0) >= (lengths[oldIndex]?.[newIndex + 1] ?? 0))
    ) {
      operations.push(line('remove', '-', oldLine));
      oldIndex += 1;
    } else if (newLine !== undefined) {
      operations.push(line('add', '+', newLine));
      newIndex += 1;
    } else {
      throw new Error('Invalid compact diff operation');
    }
  }
  return operations;
}

function compactOperations(operations: CompactDiffLine[]): {
  lines: CompactDiffLine[];
  shownChangedLines: number;
  omittedBefore: boolean;
  omittedAfter: boolean;
} {
  const removalIndexes = operationIndexes(operations, 'remove');
  const additionIndexes = operationIndexes(operations, 'add');
  let removalLimit = Math.min(removalIndexes.length, Math.ceil(MAX_RENDERED_CHANGED_LINES / 2));
  let additionLimit = Math.min(additionIndexes.length, MAX_RENDERED_CHANGED_LINES - removalLimit);
  removalLimit = Math.min(removalIndexes.length, MAX_RENDERED_CHANGED_LINES - additionLimit);
  additionLimit = Math.min(additionIndexes.length, MAX_RENDERED_CHANGED_LINES - removalLimit);
  const selectedChanges = new Set([
    ...removalIndexes.slice(0, removalLimit),
    ...additionIndexes.slice(0, additionLimit),
  ]);
  const selectedIndexes = new Set(selectedChanges);
  for (const changeIndex of selectedChanges) {
    for (
      let index = Math.max(0, changeIndex - CONTEXT_LINES);
      index <= Math.min(operations.length - 1, changeIndex + CONTEXT_LINES);
      index += 1
    ) {
      if (operations[index]?.kind === 'context') {
        selectedIndexes.add(index);
      }
    }
  }
  const orderedIndexes = [...selectedIndexes].sort((left, right) => left - right);
  const lines: CompactDiffLine[] = [];
  let previousIndex: number | null = null;
  for (const index of orderedIndexes) {
    if (previousIndex !== null && index > previousIndex + 1) {
      lines.push(line('context', ' ', '...'));
    }
    const operation = operations[index];
    if (!operation) {
      throw new Error('Invalid compact diff operation index');
    }
    lines.push(operation);
    previousIndex = index;
  }
  const firstIndex = orderedIndexes[0];
  const lastIndex = orderedIndexes[orderedIndexes.length - 1];
  return {
    lines,
    shownChangedLines: selectedChanges.size,
    omittedBefore: firstIndex !== undefined && firstIndex > 0,
    omittedAfter: lastIndex !== undefined && lastIndex < operations.length - 1,
  };
}

function operationIndexes(
  operations: CompactDiffLine[],
  kind: Extract<CompactDiffLineKind, 'add' | 'remove'>,
): number[] {
  return operations.flatMap((operation, index) => (operation.kind === kind ? [index] : []));
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
