import type { GitBranchesResponse, GitDiffResponse, GitHistoryResponse } from '@bridge/types/types';
import type { LocalModelDefinition } from '../models/types';
import type { LocalRunSnapshot } from '../runtime/agentLoop';
import type { LocalThread } from '../runtime/types';
import type {
  LocalDirectoryListing,
  LocalFileRead,
  LocalGitPullResult,
  LocalGitStatus,
  LocalWorkspace,
} from '../workspaces/types';

/**
 * The narrow surface of the on-device runtime that the local transport needs. The shell chat
 * experience never touches the runtime directly; it speaks the bridge wire protocol to
 * `LocalBridgeServer`, which only uses this port. Keeping the port small lets the runtime evolve
 * (lifecycle, downloads, agent loop) without touching the shared chat shell.
 */
export interface LocalAgentPort {
  /** Called after any runtime state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  threads(): readonly LocalThread[];
  thread(id: string): LocalThread | null;
  run(): LocalRunSnapshot;
  workspaces(): readonly LocalWorkspace[];
  refreshWorkspaces(): Promise<void>;
  /** The workspace and model the user last chose in the runtime, used as new-chat defaults. */
  defaults(): { workspaceId: string | null; modelId: string | null };
  /** Catalog models whose weights are downloaded, verified, and supported by this build. */
  availableModels(): readonly LocalModelDefinition[];
  createThread(workspaceId: string, modelId: string): Promise<LocalThread>;
  updateThread(
    id: string,
    patch: Partial<Pick<LocalThread, 'title' | 'modelId' | 'workspaceId'>>,
  ): Promise<LocalThread>;
  deleteThread(id: string): Promise<void>;
  /**
   * Starts a turn. `accepted` fires once the user message is durably part of the thread; the
   * returned promise settles when the whole run settles.
   */
  send(id: string, text: string, submissionId: string, accepted: () => void): Promise<LocalThread>;
  stop(): Promise<void>;
  /** Answers the pending tool approval in `run().approval`. */
  resolveApproval(callId: string, approved: boolean): void;
  git: LocalGitPort;
  workspaceAdmin: LocalWorkspaceAdminPort;
  files: LocalFilesPort;
  /** Last known reachability; network actions fail fast only when it is `offline`. */
  network(): 'online' | 'offline' | 'unknown';
}

/** Workspace lifecycle. Mutations are serialized with agent runs and other manual operations. */
export interface LocalWorkspaceAdminPort {
  create(name: string): Promise<LocalWorkspace>;
  rename(id: string, name: string): Promise<LocalWorkspace>;
  delete(id: string): Promise<void>;
  /** Clones an HTTPS remote into a new workspace and selects it. */
  clone(name: string, url: string): Promise<LocalWorkspace>;
  cloneProgress(): { active: boolean; cancelled: boolean; completed: number; total: number };
  cancelTransfer(): void;
  changeToken(id: string): Promise<string>;
  /** Current branch and origin URL; both null for workspaces without Git. */
  metadata(id: string): Promise<{ branch: string | null; origin: string | null }>;
}

/** Workspace-relative file access for the Files screen (`''` is the root). */
export interface LocalFilesPort {
  list(id: string, path: string, limit: number): Promise<LocalDirectoryListing>;
  read(id: string, path: string, offset: number, limit: number): Promise<LocalFileRead>;
  /** `revision: null` creates a file and rejects when one already exists. */
  write(id: string, path: string, content: string, revision: string | null): Promise<string>;
  rename(id: string, path: string, destination: string): Promise<void>;
  remove(id: string, path: string): Promise<void>;
}

export interface LocalGitPort {
  status(workspaceId: string): Promise<LocalGitStatus>;
  diff(workspaceId: string): Promise<GitDiffResponse>;
  history(workspaceId: string): Promise<GitHistoryResponse>;
  branches(workspaceId: string): Promise<GitBranchesResponse>;
  stage(workspaceId: string, path: string | null): Promise<void>;
  unstage(workspaceId: string, path: string | null): Promise<void>;
  commit(workspaceId: string, message: string): Promise<void>;
  switchBranch(workspaceId: string, branch: string): Promise<void>;
  push(workspaceId: string): Promise<void>;
  fetch(workspaceId: string): Promise<void>;
  /** Fast-forward only. */
  pull(workspaceId: string): Promise<LocalGitPullResult>;
  init(workspaceId: string, branch: string, origin: string | null): Promise<LocalWorkspace>;
  discard(workspaceId: string, path: string | null, removeUntracked: boolean): Promise<void>;
  createBranch(workspaceId: string, name: string): Promise<void>;
}
