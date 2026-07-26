import type { WorkspaceSummary } from '../api/types';
import { confirmAction } from './confirm';

export const ENTRY_ROW_HEIGHT = 48;

export function toPathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function matchesSearch(values: string[], query: string): boolean {
  return !query || values.some((value) => value.toLowerCase().includes(query));
}

export function formatWorkspaceMeta(workspace: WorkspaceSummary): string {
  const relative = formatRelativeTime(workspace.updatedAt);
  if (relative) return relative;
  if (workspace.chatCount === 1) return '1 chat';
  return `${String(workspace.chatCount)} chats`;
}

function formatRelativeTime(iso?: string): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;

  const diffMs = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  const weeks = Math.floor(days / 7);

  if (seconds < 10) return 'now';
  if (seconds < 60) return `${String(seconds)} sec ago`;
  if (minutes < 60) return `${String(minutes)} min ago`;
  if (hours < 24) return `${String(hours)} hr ago`;
  if (days < 7) return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;
  if (weeks < 5) return `${String(weeks)} wk ago`;
  return `${String(Math.floor(days / 30))} mo ago`;
}

export function showWorkspacePinAction(isPinned: boolean, onAction: () => void) {
  const actionTitle = isPinned ? 'Unpin workspace' : 'Pin workspace';
  const promptTitle = isPinned ? 'Unpin this workspace?' : 'Pin this workspace?';
  void confirmAction({ title: promptTitle, confirmLabel: actionTitle }).then((confirmed) => {
    if (confirmed) onAction();
  });
}
