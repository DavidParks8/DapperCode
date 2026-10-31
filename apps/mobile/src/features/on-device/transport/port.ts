import type {
  GitBranchesResponse,
  GitDiffResponse,
  GitHistoryResponse,
  GitStatusResponse,
} from '@bridge/types/types';
import type { LocalModelDefinition } from '../models/types';
import type { LocalRunSnapshot } from '../runtime/agentLoop';
import type { LocalThread } from '../runtime/types';
import type { LocalWorkspace } from '../workspaces/types';

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
}

export interface LocalGitPort {
  status(workspaceId: string): Promise<GitStatusResponse>;
  diff(workspaceId: string): Promise<GitDiffResponse>;
  history(workspaceId: string): Promise<GitHistoryResponse>;
  branches(workspaceId: string): Promise<GitBranchesResponse>;
  stage(workspaceId: string, path: string | null): Promise<void>;
  unstage(workspaceId: string, path: string | null): Promise<void>;
  commit(workspaceId: string, message: string): Promise<void>;
  switchBranch(workspaceId: string, branch: string): Promise<void>;
  push(workspaceId: string): Promise<void>;
}
