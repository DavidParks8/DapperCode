import type { GitStatusResponse } from '@bridge/types/types';

/**
 * Workspace host extensions: JSON-RPC methods a host can answer beyond the Rust bridge contract
 * (`contracts/bridge-rpc/v2`). They are only called when the active profile advertises the
 * matching flag in `activeProfileFeaturesAtom`, so a bridge that does not implement them is never
 * asked. Today the in-process "On this iPhone" transport implements all of them.
 */
export const WORKSPACE_HOST_METHODS = {
  workspaceList: 'workspace/list',
  workspaceCreate: 'workspace/create',
  workspaceRename: 'workspace/rename',
  workspaceDelete: 'workspace/delete',
  workspaceChangeToken: 'workspace/changeToken',
  cloneProgress: 'workspace/clone/progress',
  cloneCancel: 'workspace/clone/cancel',
  gitFetch: 'workspace/git/fetch',
  gitPull: 'workspace/git/pull',
  gitInit: 'workspace/git/init',
  gitDiscard: 'workspace/git/discard',
  gitBranchCreate: 'workspace/git/branch/create',
  filesList: 'workspace/files/list',
  filesRead: 'workspace/files/read',
  filesWrite: 'workspace/files/write',
  filesCreate: 'workspace/files/create',
  filesRename: 'workspace/files/rename',
  filesRemove: 'workspace/files/remove',
} as const;

export type WorkspaceHostMethod =
  (typeof WORKSPACE_HOST_METHODS)[keyof typeof WORKSPACE_HOST_METHODS];

export type HostReachability = 'online' | 'offline' | 'unknown';

/**
 * Remote state a host may attach to `bridge/git/status` as `remote`. Hosts that omit it keep the
 * bridge behaviour of parsing the porcelain header in `raw`.
 */
export interface GitRemoteState {
  hasOrigin: boolean;
  origin: string | null;
  /** Upstream branch such as `origin/main`, or null when none is configured. */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  detached: boolean;
  /** A repository without commits yet. */
  unborn: boolean;
  network: HostReachability;
}

export type GitStatusWithRemote = GitStatusResponse & { remote?: GitRemoteState };

export interface ManagedWorkspaceResponse {
  path: string;
  name: string;
  isRepository: boolean;
}

/** One app-managed workspace with the Git details the picker shows. */
export interface ManagedWorkspaceSummary extends ManagedWorkspaceResponse {
  /** Current branch; null without Git or before the first commit on a detached HEAD. */
  branch: string | null;
  origin: string | null;
}

export interface CloneProgressResponse {
  active: boolean;
  cancelled: boolean;
  completed: number;
  total: number;
}

export interface GitPullResponse {
  outcome: 'up-to-date' | 'fast-forwarded';
  from: string | null;
  to: string;
}

export type WorkspaceFileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface WorkspaceFileEntry {
  name: string;
  /** Workspace-relative path; `''` is the workspace root. */
  path: string;
  kind: WorkspaceFileKind;
  bytes: number;
}

export interface WorkspaceFileListResponse {
  cwd: string;
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  limit: number;
}

export interface WorkspaceFileReadResponse {
  path: string;
  content: string;
  revision: string;
  /** True when `content` is only the beginning of the file. */
  truncated: boolean;
  totalBytes: number;
}

export interface WorkspaceFileWriteResponse {
  path: string;
  revision: string;
}
