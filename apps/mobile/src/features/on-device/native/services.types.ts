import type { GitBranchesResponse, GitDiffResponse, GitHistoryResponse } from '@bridge/types/types';
import type {
  LocalDirectoryListing,
  LocalFileRead,
  LocalGitPullResult,
  LocalGitStatus,
  LocalSearchResult,
  LocalWorkspace,
} from '../workspaces/types';
import type { DeviceMemory, LocalModelFile, LocalModelPaths } from '../models/types';
import type {
  NativeModelStorageInfo,
  NativeModelTransfer,
  NativeModelVerificationProgress,
} from '../models/downloadState';

export const ON_DEVICE_NATIVE_API_VERSION = 8;

/** Native event carrying throttled clone, fetch, pull, and push progress (API 8). */
export const GIT_TRANSFER_PROGRESS_EVENT = 'onGitTransferProgress';

export interface NativeGitTransferProgress {
  active: boolean;
  cancelled: boolean;
  completed: number;
  total: number;
}

/**
 * Native on-device services. Every rejection is an `OnDeviceNativeError` with a stable `code`
 * (see `services.errors.ts`). Workspace-relative paths use `''` for the workspace root.
 */

export interface OnDeviceNativeServices {
  getAPIVersion(): number;
  getMemoryInfo(): DeviceMemory;
  cancelGitTransfer(): void;
  /** One read of the shared transfer state; live updates arrive as `GIT_TRANSFER_PROGRESS_EVENT`. */
  getGitTransferProgress(): NativeGitTransferProgress;
  /**
   * Expo module event subscription. Native sends an update when a transfer begins, is cancelled,
   * or ends, and at most every 100 ms (plus the final object) while objects arrive.
   */
  addListener(
    eventName: typeof GIT_TRANSFER_PROGRESS_EVENT,
    listener: (progress: NativeGitTransferProgress) => void,
  ): { remove(): void };
  storeGitCredential(
    host: string,
    accountId: string,
    username: string,
    token: string,
  ): Promise<string>;
  removeGitCredential(reference: string): Promise<void>;
  listWorkspaces(): Promise<LocalWorkspace[]>;
  createWorkspace(name: string): Promise<LocalWorkspace>;
  cloneWorkspace(
    name: string,
    remote: string,
    credentialRef: string | null,
  ): Promise<LocalWorkspace>;
  renameWorkspace(id: string, name: string): Promise<LocalWorkspace>;
  /** Removes the workspace and all of its files. Conversations referencing it are not touched. */
  deleteWorkspace(id: string): Promise<void>;
  /**
   * Opaque token that changes after every app-initiated change to the workspace's files, Git index,
   * branches, or metadata (including agent tool edits). Compare tokens to decide when to refresh.
   */
  getWorkspaceChangeToken(id: string): Promise<string>;
  listWorkspaceFiles(id: string, path: string, limit: number): Promise<LocalDirectoryListing>;
  readWorkspaceFile(
    id: string,
    path: string,
    offset: number,
    limit: number,
  ): Promise<LocalFileRead>;
  writeWorkspaceFile(
    id: string,
    path: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<string>;
  editWorkspaceFile(
    id: string,
    path: string,
    oldText: string,
    newText: string,
    expectedRevision: string,
  ): Promise<string>;
  renameWorkspacePath(
    id: string,
    path: string,
    destination: string,
    expectedRevision: string | null,
  ): Promise<void>;
  removeWorkspacePath(id: string, path: string, expectedRevision: string | null): Promise<void>;
  /** User-initiated rename for the Files UI; no revision precondition. */
  renameWorkspaceEntry(id: string, path: string, destination: string): Promise<void>;
  /** User-initiated delete for the Files UI; no revision precondition. Cannot remove the root. */
  removeWorkspaceEntry(id: string, path: string): Promise<void>;
  searchWorkspaceFiles(id: string, query: string): Promise<LocalSearchResult>;
  getModelFilePaths(id: string): Promise<LocalModelPaths>;
  getDownloadedModelFile(id: string): Promise<LocalModelFile | null>;
  finalizeModelDownload(id: string, sha256: string, bytes: number): Promise<LocalModelFile>;
  removeModelFile(id: string): Promise<void>;
  attachModelDownloads(): Promise<NativeModelTransfer[]>;
  startModelDownload(id: string, url: string, expectedBytes: number): Promise<NativeModelTransfer>;
  pauseModelDownload(id: string): Promise<NativeModelTransfer>;
  cancelModelDownload(id: string): Promise<void>;
  getModelDownload(id: string): NativeModelTransfer;
  getModelVerificationProgress(id: string): NativeModelVerificationProgress;
  cancelModelVerification(id: string): void;
  getModelStorageInfo(): Promise<NativeModelStorageInfo>;
  readRuntimeDocument(name: string): Promise<string | null>;
  writeRuntimeDocument(name: string, content: string): Promise<void>;
  listRuntimeDocuments(prefix: string): Promise<string[]>;
  removeRuntimeDocument(name: string): Promise<void>;
  /** Rejects with `GIT_NOT_REPOSITORY` for workspaces without Git metadata. */
  getWorkspaceGitStatus(id: string): Promise<LocalGitStatus>;
  getWorkspaceGitDiff(id: string, maximumBytes: number | null): Promise<GitDiffResponse>;
  getWorkspaceGitHistory(id: string): Promise<GitHistoryResponse>;
  getWorkspaceGitBranches(id: string): Promise<GitBranchesResponse>;
  stageWorkspaceGit(id: string, path: string | null): Promise<void>;
  unstageWorkspaceGit(id: string, path: string | null): Promise<void>;
  /** Rejects with `GIT_NOTHING_TO_COMMIT` when the index matches HEAD. */
  commitWorkspaceGit(id: string, message: string, name: string, email: string): Promise<string>;
  switchWorkspaceGitBranch(id: string, branch: string): Promise<void>;
  /** Creates a local branch at HEAD; `checkout` keeps working-tree changes, like `git switch -c`. */
  createWorkspaceGitBranch(id: string, name: string, checkout: boolean): Promise<void>;
  /**
   * Restores working-tree files from the index (staged changes are kept). A single untracked path
   * is deleted. For all files, untracked files are removed only when `removeUntracked` is true.
   * Ignored files and files staged for deletion but still on disk are never removed; a per-path
   * discard of a staged deletion rejects with `INVALID_ARGUMENT`.
   */
  discardWorkspaceGit(id: string, path: string | null, removeUntracked: boolean): Promise<void>;
  /** Initializes Git in a workspace that has none, optionally adding an HTTPS `origin`. */
  initWorkspaceGit(
    id: string,
    initialBranch: string,
    origin: string | null,
  ): Promise<LocalWorkspace>;
  /** Rejects with `GIT_NO_ORIGIN` when no origin is configured. */
  getWorkspaceGitOrigin(id: string): Promise<string>;
  /** Fetches origin. Same HTTPS, credential-origin, cancellation, and timeout rules as push. */
  fetchWorkspaceGit(id: string, credentialRef: string | null): Promise<void>;
  /**
   * Fetches origin and fast-forwards the current branch. Rejects with `GIT_NON_FAST_FORWARD` for
   * diverged histories and `GIT_CONFLICT` when local changes would be overwritten.
   */
  pullWorkspaceGit(id: string, credentialRef: string | null): Promise<LocalGitPullResult>;
  pushWorkspaceGit(id: string, credentialRef: string | null): Promise<void>;
}
