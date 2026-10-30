import type { GitStatusResponse } from '@bridge/types/types';

export interface LocalWorkspace {
  id: string;
  name: string;
  /** Whether the workspace root contains Git metadata. Empty workspaces can be initialized. */
  isRepository: boolean;
}

/** The workspace root is always the empty path. */
export const LOCAL_WORKSPACE_ROOT = '';

export function joinWorkspacePath(directory: string, name: string): string {
  return directory === LOCAL_WORKSPACE_ROOT ? name : `${directory}/${name}`;
}

export function parentWorkspacePath(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

export interface LocalFileRead {
  path: string;
  content: string;
  revision: string;
  nextOffset: number | null;
  /** Size of the whole file in bytes, independent of the returned chunk. */
  totalBytes: number;
}

export interface LocalDirectoryListing {
  entries: {
    name: string;
    kind: 'file' | 'directory' | 'symlink' | 'other';
    bytes: number;
  }[];
  truncated: boolean;
}

export interface LocalSearchResult {
  matches: { path: string; line: number; content: string }[];
  truncated: boolean;
  skippedFiles: number;
  visitedEntries: number;
  searchedBytes: number;
}

/** Bridge-compatible Git status plus the remote state the local Git UI needs. */
export interface LocalGitStatus extends GitStatusResponse {
  stagedFiles: number;
  hasOrigin: boolean;
  origin: string | null;
  /** Upstream branch such as `origin/main`, or null when none is configured or fetched. */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  detached: boolean;
  unborn: boolean;
}

export interface LocalGitPullResult {
  outcome: 'up-to-date' | 'fast-forwarded';
  from: string | null;
  to: string;
}
