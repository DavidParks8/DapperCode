import type { GitStatusFile } from '../../api/types';
import type { UnifiedDiffFile } from './gitDiff';

export interface ChangedFileEntry {
  code: string;
  path: string;
  stagePath: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export function parseChangedFiles(rawStatus: string): ChangedFileEntry[] {
  const lines = rawStatus
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const files: ChangedFileEntry[] = [];
  for (const line of lines) {
    if (line.startsWith('## ') || line.length < 3) {
      continue;
    }

    const indexStatus = line[0] ?? ' ';
    const worktreeStatus = line[1] ?? ' ';
    const code = `${indexStatus}${worktreeStatus}`;
    const path = line.slice(3).trim();
    if (!path) {
      continue;
    }

    const stagePath = extractStagePath(path);
    const untracked = code === '??';
    const staged = !untracked && indexStatus !== ' ';
    const unstaged = untracked || worktreeStatus !== ' ';

    files.push({ code, path, stagePath, staged, unstaged, untracked });
  }

  return files;
}

export function mapStatusFileToChangedEntry(file: GitStatusFile): ChangedFileEntry {
  const displayPath = file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path;
  return {
    code: `${file.indexStatus}${file.worktreeStatus}`,
    path: displayPath,
    stagePath: file.path,
    staged: file.staged,
    unstaged: file.unstaged,
    untracked: file.untracked,
  };
}

export function parseAheadCount(rawStatus: string): number {
  const header = findStatusHeader(rawStatus);
  if (!header) {
    return 0;
  }

  const match = header.match(/\bahead\s+(\d+)\b/i);
  if (!match) {
    return 0;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseBehindCount(rawStatus: string): number {
  const header = findStatusHeader(rawStatus);
  if (!header) {
    return 0;
  }

  const match = header.match(/\bbehind\s+(\d+)\b/i);
  if (!match) {
    return 0;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseHasUpstream(rawStatus: string): boolean {
  return findStatusHeader(rawStatus)?.includes('...') ?? false;
}

export function parseUpstreamBranch(rawStatus: string): string | null {
  const header = findStatusHeader(rawStatus);
  if (!header) {
    return null;
  }

  const normalized = header.replace(/^##\s+/, '');
  const upstreamSection = normalized.split('...')[1] ?? '';
  const upstream = upstreamSection.split('[')[0]?.trim() ?? '';
  return upstream || null;
}

export function formatSyncDisplay(aheadCount: number, behindCount: number): string | null {
  if (aheadCount <= 0 && behindCount <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (aheadCount > 0) {
    parts.push(`${aheadCount} ahead`);
  }
  if (behindCount > 0) {
    parts.push(`${behindCount} behind`);
  }
  return parts.join(', ');
}

export function isPublishableBranch(branch: string | null | undefined): boolean {
  const normalized = branch?.trim();
  return Boolean(normalized && normalized !== 'unknown' && !normalized.startsWith('HEAD'));
}

export function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);

  if (absoluteSeconds < 60) {
    return deltaSeconds >= 0 ? 'in a moment' : 'just now';
  }

  const chosen: { unit: Intl.RelativeTimeFormatUnit; seconds: number } =
    absoluteSeconds < 60 * 60
      ? { unit: 'minute', seconds: 60 }
      : absoluteSeconds < 60 * 60 * 24
        ? { unit: 'hour', seconds: 60 * 60 }
        : absoluteSeconds < 60 * 60 * 24 * 7
          ? { unit: 'day', seconds: 60 * 60 * 24 }
          : absoluteSeconds < 60 * 60 * 24 * 30
            ? { unit: 'week', seconds: 60 * 60 * 24 * 7 }
            : absoluteSeconds < 60 * 60 * 24 * 365
              ? { unit: 'month', seconds: 60 * 60 * 24 * 30 }
              : { unit: 'year', seconds: 60 * 60 * 24 * 365 };

  const valueInUnit = Math.round(deltaSeconds / chosen.seconds);
  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
      valueInUnit,
      chosen.unit,
    );
  } catch {
    const label = Math.abs(valueInUnit) === 1 ? chosen.unit : `${chosen.unit}s`;
    return valueInUnit < 0 ? `${Math.abs(valueInUnit)} ${label} ago` : `in ${valueInUnit} ${label}`;
  }
}

export function formatDiffLineNumber(value: number | null): string {
  if (value === null || value <= 0) {
    return '';
  }
  return String(value);
}

export function formatStatusCode(code: string): string {
  if (!code) {
    return '??';
  }
  if (code === '??') {
    return code;
  }

  const normalized = code.replace(/ /g, '·');
  return normalized.trim() ? normalized : '··';
}

export function getDiffFileLookupKeys(file: UnifiedDiffFile): string[] {
  const keys = [file.displayPath, file.oldPath, file.newPath].filter((value): value is string =>
    Boolean(value),
  );
  return Array.from(new Set(keys));
}

export function findDiffFileIdForEntry(
  entry: Pick<ChangedFileEntry, 'path' | 'stagePath'>,
  files: UnifiedDiffFile[],
): string | null {
  if (files.length === 0) {
    return null;
  }

  const lookupCandidates = new Set<string>([entry.path, entry.stagePath]);
  for (const file of files) {
    const keys = getDiffFileLookupKeys(file);
    if (keys.some((key) => lookupCandidates.has(key))) {
      return file.id;
    }
  }

  return null;
}

export function extractStagePath(path: string): string {
  const parts = path.split(' -> ');
  const candidate = parts[parts.length - 1]?.trim() ?? path.trim();
  return candidate || path.trim();
}

function findStatusHeader(rawStatus: string): string | undefined {
  return rawStatus
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('## '));
}
