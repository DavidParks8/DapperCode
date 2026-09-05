import type { ChatToolKind, ChatToolStatus } from '@bridge/types/types';
import { buildCompactDiff, type CompactDiff } from '@shared/diff/compactDiff';
import {
  normalizeLocationPath,
  type ToolInvocation,
  type ToolInvocationDiff,
} from './toolInvocationModel';

const TOOL_STATUS_PHRASES: Record<ChatToolKind, Record<ChatToolStatus, string>> = {
  read: {
    pending: 'Waiting to read',
    in_progress: 'Reading',
    completed: 'Read',
    failed: 'Failed to read',
  },
  edit: {
    pending: 'Waiting to edit',
    in_progress: 'Editing',
    completed: 'Edited',
    failed: 'Failed to edit',
  },
  delete: {
    pending: 'Waiting to delete',
    in_progress: 'Deleting',
    completed: 'Deleted',
    failed: 'Failed to delete',
  },
  move: {
    pending: 'Waiting to move',
    in_progress: 'Moving',
    completed: 'Moved',
    failed: 'Failed to move',
  },
  search: {
    pending: 'Waiting to search',
    in_progress: 'Searching',
    completed: 'Searched',
    failed: 'Failed to search',
  },
  execute: {
    pending: 'Waiting to run',
    in_progress: 'Running',
    completed: 'Ran',
    failed: 'Failed to run',
  },
  think: {
    pending: 'Waiting to think',
    in_progress: 'Thinking',
    completed: 'Thought',
    failed: 'Failed to think',
  },
  fetch: {
    pending: 'Waiting to fetch',
    in_progress: 'Fetching',
    completed: 'Fetched',
    failed: 'Failed to fetch',
  },
  switch_mode: {
    pending: 'Waiting to switch mode',
    in_progress: 'Switching mode',
    completed: 'Switched mode',
    failed: 'Failed to switch mode',
  },
  other: {
    pending: 'Waiting',
    in_progress: 'Running',
    completed: 'Ran',
    failed: 'Failed',
  },
};

const KIND_VERB_PREFIXES: Partial<Record<ChatToolKind, RegExp>> = {
  read: /^(?:read|reading|reads)\b\s*/i,
  edit: /^(?:edit|editing|edited|update|updating|updated|write|writing|wrote)\b\s*/i,
  delete: /^(?:delete|deleting|deleted|remove|removing|removed)\b\s*/i,
  move: /^(?:move|moving|moved|rename|renaming|renamed)\b\s*/i,
  search: /^(?:search|searching|searched|searches|grep|grepping|grepped)\b\s*/i,
  think: /^(?:think|thinking|thought|reason|reasoning|reasoned)\b\s*/i,
  fetch: /^(?:fetch|fetching|fetched|download|downloading|downloaded)\b\s*/i,
  switch_mode: /^(?:switch|switching|switched)\b(?:\s+mode)?\s*/i,
};

const ANY_RECOGNIZED_VERB_PREFIX =
  /^(?:read|reading|edit|editing|edited|update|updating|updated|write|writing|wrote|delete|deleting|deleted|remove|removing|removed|move|moving|moved|rename|renaming|renamed|search|searching|searched|grep|grepping|grepped|run|running|ran|execute|executing|executed|think|thinking|thought|reason|reasoning|reasoned|fetch|fetching|fetched|download|downloading|downloaded|switch|switching|switched)\b/i;

export interface ToolInvocationHeader {
  action: string;
  subject: string;
  label: string;
  status: ChatToolStatus;
}

export interface ToolInvocationFile {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export function resolveToolInvocationFiles(invocation: ToolInvocation): ToolInvocationFile[] {
  const files = new Map<string, ToolInvocationFile>();
  for (const diff of invocation.diffs) {
    const stats = compactToolDiff(diff);
    const path = normalizeLocationPath(diff.path);
    files.set(path, {
      path,
      additions: stats.unavailable ? null : stats.additions,
      deletions: stats.unavailable ? null : stats.deletions,
    });
  }
  if (['edit', 'delete', 'move'].includes(invocation.kind)) {
    for (const { path } of invocation.locations) {
      if (!files.has(path)) {
        files.set(path, { path, additions: null, deletions: null });
      }
    }
  }
  return [...files.values()];
}

export function formatChangedLineCount(count: number, kind: 'added' | 'removed'): string {
  return `${String(count)} ${count === 1 ? 'line' : 'lines'} ${kind}`;
}

export function resolveToolInvocationHeader(
  invocation: ToolInvocation,
  threadRunning = true,
): ToolInvocationHeader {
  const status =
    !threadRunning && ['pending', 'in_progress'].includes(invocation.status)
      ? 'completed'
      : invocation.status;
  const title = toSingleLine(invocation.title);
  if (invocation.statusLanguage === false) {
    return { action: '', subject: title, label: title, status };
  }

  const action = TOOL_STATUS_PHRASES[invocation.kind][status];
  const subject = resolveHeaderSubject(invocation, title);
  const files = resolveToolInvocationFiles(invocation);
  if (['edit', 'delete', 'move'].includes(invocation.kind) && files.length > 0) {
    const editSubject = resolveEditSubject(files);
    return {
      action,
      subject: editSubject,
      label: joinHeader(action, editSubject),
      status,
    };
  }
  if (invocation.kind === 'other' && ANY_RECOGNIZED_VERB_PREFIX.test(title)) {
    return { action: '', subject: title, label: title, status };
  }
  return { action, subject, label: joinHeader(action, subject), status };
}

export function compactToolDiff(diff: ToolInvocationDiff): CompactDiff {
  return diff.compact ?? buildCompactDiff(diff.oldText, diff.newText);
}

function resolveHeaderSubject(invocation: ToolInvocation, title: string): string {
  const normalizedTitle = title.toLowerCase();
  if (
    !title ||
    normalizedTitle === invocation.kind ||
    normalizedTitle === invocation.kind.replace(/_/g, ' ')
  ) {
    return '';
  }
  if (invocation.kind === 'execute') {
    return title;
  }
  const ownPrefix = KIND_VERB_PREFIXES[invocation.kind];
  if (ownPrefix?.test(title)) {
    return title.replace(ownPrefix, '').trim();
  }
  if (ANY_RECOGNIZED_VERB_PREFIX.test(title)) {
    return title;
  }
  return title;
}

function resolveEditSubject(files: ToolInvocationFile[]): string {
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const stats = files.every((file) => file.additions !== null && file.deletions !== null)
    ? formatDiffStats(additions, deletions)
    : '';
  if (files.length === 1) {
    return [basename(files[0]?.path ?? ''), stats].filter(Boolean).join(' ');
  }
  return [`${String(files.length)} files`, stats].filter(Boolean).join(' ');
}

function formatDiffStats(additions: number, deletions: number): string {
  return [
    additions > 0 ? `+${String(additions)}` : '',
    deletions > 0 ? `-${String(deletions)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function joinHeader(action: string, subject: string): string {
  return [action, subject].filter(Boolean).join(' ');
}

function toSingleLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}
