import type { WorkspaceSummary } from '@bridge/types/types';

export const ENTRY_ROW_HEIGHT = 56;

export function toPathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One rung of the folder path, ordered current-first so the title menu reads top-down like Files. */
export interface WorkspacePathCrumb {
  path: string;
  name: string;
  /** 0 for the current folder, 1 for its parent, and so on — drives the menu's indent. */
  depth: number;
}

/**
 * Expands a path into the chain the title menu offers, so climbing several levels is one tap
 * instead of repeated trips through a parent button.
 */
export function toPathCrumbs(path: string | null): WorkspacePathCrumb[] {
  if (!path) {
    return [];
  }
  const isPosix = path.startsWith('/');
  const separator = isPosix ? '/' : '\\';
  const segments = path.split(/[\\/]/).filter(Boolean);
  const crumbs: WorkspacePathCrumb[] = [];
  for (let length = segments.length; length > 0; length -= 1) {
    const branch = segments.slice(0, length);
    const joined = branch.join(separator);
    crumbs.push({
      path: isPosix ? `${separator}${joined}` : joined,
      name: branch[branch.length - 1] ?? path,
      depth: segments.length - length,
    });
  }
  if (isPosix) {
    crumbs.push({ path: separator, name: separator, depth: segments.length });
  }
  return crumbs;
}

export function formatFolderCount(count: number): string {
  return count === 1 ? '1 folder' : `${String(count)} folders`;
}

export function matchesSearch(values: string[], query: string): boolean {
  return !query || values.some((value) => value.toLowerCase().includes(query));
}

export function formatWorkspaceMeta(workspace: WorkspaceSummary): string {
  const relative = formatRelativeTime(workspace.updatedAt);
  if (relative) {
    return relative;
  }
  if (workspace.chatCount === 1) {
    return '1 chat';
  }
  return `${String(workspace.chatCount)} chats`;
}

function formatRelativeTime(iso?: string): string | null {
  if (!iso) {
    return null;
  }
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  const weeks = Math.floor(days / 7);

  if (seconds < 10) {
    return 'now';
  }
  if (seconds < 60) {
    return `${String(seconds)} sec ago`;
  }
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  if (hours < 24) {
    return `${String(hours)} hr ago`;
  }
  if (days < 7) {
    return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;
  }
  if (weeks < 5) {
    return `${String(weeks)} wk ago`;
  }
  return `${String(Math.floor(days / 30))} mo ago`;
}
