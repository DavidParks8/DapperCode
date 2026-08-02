import type { RunEvent, ChatMessage as ChatTranscriptMessage } from '../../api/types';
import { readString, toRecord } from '../../runtimeValidation';
import { MAX_ACTIVE_COMMANDS } from './mainScreenHelperTypes';

export function stripMarkdownInline(value: string): string {
  return value
    .replace(/(^|\n)\s{0,3}#{1,6}\s*/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[_~]/g, '');
}

export function toTickerSnippet(value: string | null | undefined, maxLength = 72): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function mergeStreamingDelta(previous: string | null, delta: string): string {
  if (!delta) {
    return previous ?? '';
  }

  const prev = previous ?? '';
  if (!prev) {
    return delta;
  }

  if (delta === prev || prev.endsWith(delta)) {
    return prev;
  }

  // Some transports send cumulative snapshots instead of token deltas.
  if (delta.startsWith(prev)) {
    return delta;
  }

  const maxOverlap = Math.min(prev.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (prev.endsWith(delta.slice(0, overlap))) {
      return prev + delta.slice(overlap);
    }
  }

  return prev + delta;
}

export function formatLiveReasoningMessage(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return '• Reasoning';
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return '• Reasoning';
  }

  const [first, ...rest] = lines;
  return ['• Reasoning', `  └ ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
}

export function formatTimelineSystemMessage(title: string, details: string[]): string {
  const normalizedDetails = details
    .flatMap((detail) => detail.split('\n'))
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const [first, ...rest] = normalizedDetails;
  if (!first) {
    return title;
  }
  return [title, `  └ ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
}

export function filterReasoningMessages(
  messages: ChatTranscriptMessage[],
): ChatTranscriptMessage[] {
  return messages;
}

export function describeStartedToolEvent(
  item: Record<string, unknown> | null,
): { eventType: string; detail: string } | null {
  const itemType = readString(item?.type);
  if (itemType === 'commandExecution') {
    const command = toTickerSnippet(readString(item?.command), 80) ?? 'Command';
    return {
      eventType: 'command.running',
      detail: buildToolEventDetail(command, 'running'),
    };
  }

  if (itemType === 'fileChange') {
    return {
      eventType: 'file_change.running',
      detail: buildToolEventDetail('Applying file changes', 'running'),
    };
  }

  if (itemType === 'mcpToolCall') {
    const detail =
      [readString(item?.server), readString(item?.tool)].filter(Boolean).join(' / ') || 'Tool call';
    return {
      eventType: 'tool.running',
      detail: buildToolEventDetail(detail, 'running'),
    };
  }

  if (itemType === 'toolCall') {
    const detail = readString(item?.tool) ?? readString(item?.name) ?? 'Tool call';
    return {
      eventType: 'tool.running',
      detail: buildToolEventDetail(detail, 'running'),
    };
  }

  return null;
}

export function describeCompletedToolEvent(
  item: Record<string, unknown> | null,
): { eventType: string; detail: string } | null {
  const itemType = readString(item?.type);
  const rawStatus = readString(item?.status);
  const status: 'complete' | 'error' =
    rawStatus === 'failed' || rawStatus === 'error' ? 'error' : 'complete';

  if (itemType === 'commandExecution') {
    const command = toTickerSnippet(readString(item?.command), 80) ?? 'Command';
    return {
      eventType: 'command.completed',
      detail: buildToolEventDetail(command, status),
    };
  }

  if (itemType === 'fileChange') {
    const changedPaths = readCompletedFileChangePaths(item);
    const changedFileLabel =
      changedPaths.length === 0
        ? 'File changes'
        : changedPaths.length === 1
          ? `File changes: ${toTickerSnippet(toFileChangeTargetLabel(changedPaths[0]), 48) ?? 'file'}`
          : `File changes: ${toTickerSnippet(toFileChangeTargetLabel(changedPaths[0]), 40) ?? 'file'} +${String(changedPaths.length - 1)}`;
    return {
      eventType: 'file_change.completed',
      detail: buildToolEventDetail(changedFileLabel, status),
    };
  }

  if (itemType === 'mcpToolCall') {
    const detail =
      [readString(item?.server), readString(item?.tool)].filter(Boolean).join(' / ') || 'Tool call';
    return {
      eventType: 'tool.completed',
      detail: buildToolEventDetail(detail, status),
    };
  }

  if (itemType === 'toolCall') {
    const detail = readString(item?.tool) ?? readString(item?.name) ?? 'Tool call';
    return {
      eventType: 'tool.completed',
      detail: buildToolEventDetail(detail, status),
    };
  }

  return null;
}

export function describeWebSearchToolEvent(
  msg: Record<string, unknown> | null,
): { eventType: string; detail: string } | null {
  const query = toTickerSnippet(readString(msg?.query), 80);
  return {
    eventType: 'web_search.running',
    detail: buildToolEventDetail(query ? `Web search: ${query}` : 'Web search', 'running'),
  };
}

export function buildToolEventDetail(
  label: string,
  status: 'running' | 'complete' | 'error',
): string {
  return `${label} | ${status}`;
}

export function readCompletedFileChangePaths(item: Record<string, unknown> | null): string[] {
  const rawChanges = Array.isArray(item?.changes) ? item.changes : [];
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const change of rawChanges) {
    const changeRecord = toRecord(change);
    const path =
      readString(change)?.trim() ??
      readString(changeRecord?.path)?.trim() ??
      readString(changeRecord?.filePath)?.trim() ??
      readString(changeRecord?.file_path)?.trim();
    if (!path) {
      continue;
    }
    const normalized = path.replace(/\\/g, '/');
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }

  return paths;
}

export function toFileChangeTargetLabel(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    return 'file';
  }

  const basename = normalized.split('/').filter(Boolean).pop();
  return basename && basename.length > 0 ? basename : normalized;
}

export function appendRunEventHistory(
  previous: RunEvent[],
  threadId: string,
  eventType: string,
  detail: string,
): RunEvent[] {
  const last = previous[previous.length - 1];
  if (last && last.eventType === eventType && last.detail === detail) {
    return previous;
  }

  const next: RunEvent = {
    id: `re-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    threadId,
    eventType,
    at: new Date().toISOString(),
    detail,
  };

  return [...previous, next].slice(-MAX_ACTIVE_COMMANDS);
}
