import type { RpcNotification } from '@bridge/types/types';
import { readFiniteNumber } from '@shared/runtimeValidation';
import {
  WORKSPACE_HOST_METHODS as M,
  WORKSPACE_HOST_NOTIFICATIONS,
  type CloneProgressResponse,
  type GitPullResponse,
  type ManagedWorkspaceResponse,
  type ManagedWorkspaceState,
  type ManagedWorkspaceSummary,
  type WorkspaceFileListResponse,
  type WorkspaceFileReadResponse,
  type WorkspaceFileWriteResponse,
} from './protocol';

/** The part of `HostBridgeWsClient` the extensions need, so tests can pass a plain fake. */
export interface WorkspaceHostTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: RpcNotification) => void): () => void;
}

function readCloneProgress(params: Record<string, unknown> | null): CloneProgressResponse | null {
  const completed = readFiniteNumber(params?.['completed']);
  const total = readFiniteNumber(params?.['total']);
  if (!params || completed === null || total === null) {
    return null;
  }
  return {
    active: params['active'] === true,
    cancelled: params['cancelled'] === true,
    completed,
    total,
  };
}

/** Typed client for the workspace host extensions in `protocol.ts`. */
export class WorkspaceHostClient {
  constructor(private readonly transport: WorkspaceHostTransport) {}

  listWorkspaces(): Promise<{ workspaces: ManagedWorkspaceSummary[] }> {
    return this.transport.request(M.workspaceList, {});
  }
  /** Working-tree state of each Git workspace; workspaces whose state is unknown are omitted. */
  workspaceStates(): Promise<{ states: ManagedWorkspaceState[] }> {
    return this.transport.request(M.workspaceStates, {});
  }
  /** Makes the workspace the host's default for new chats. */
  selectWorkspace(cwd: string): Promise<{ ok: true; cwd: string }> {
    return this.transport.request(M.workspaceSelect, { cwd });
  }
  createWorkspace(name: string): Promise<ManagedWorkspaceResponse> {
    return this.transport.request(M.workspaceCreate, { name });
  }
  renameWorkspace(cwd: string, name: string): Promise<ManagedWorkspaceResponse> {
    return this.transport.request(M.workspaceRename, { cwd, name });
  }
  deleteWorkspace(cwd: string): Promise<{ ok: true; cwd: string }> {
    return this.transport.request(M.workspaceDelete, { cwd });
  }
  changeToken(cwd: string): Promise<{ token: string }> {
    return this.transport.request(M.workspaceChangeToken, { cwd });
  }
  /** One read of the host's transfer progress; use `onCloneProgress` to follow it. */
  cloneProgress(): Promise<CloneProgressResponse> {
    return this.transport.request(M.cloneProgress, {});
  }
  /** Progress pushed by the host while a Git transfer runs; returns the unsubscribe function. */
  onCloneProgress(listener: (progress: CloneProgressResponse) => void): () => void {
    return this.transport.onEvent((event) => {
      if (event.method !== WORKSPACE_HOST_NOTIFICATIONS.cloneProgress) {
        return;
      }
      const progress = readCloneProgress(event.params);
      if (progress) {
        listener(progress);
      }
    });
  }
  cancelClone(): Promise<{ ok: true }> {
    return this.transport.request(M.cloneCancel, {});
  }
  gitFetch(cwd: string): Promise<{ fetched: true; cwd: string }> {
    return this.transport.request(M.gitFetch, { cwd });
  }
  gitPull(cwd: string): Promise<GitPullResponse & { cwd: string }> {
    return this.transport.request(M.gitPull, { cwd });
  }
  gitInit(cwd: string, origin: string | null): Promise<ManagedWorkspaceResponse> {
    return this.transport.request(M.gitInit, { cwd, branch: 'main', origin });
  }
  /** Restores unstaged changes from the index; `path: null` discards every file. */
  gitDiscard(
    cwd: string,
    path: string | null,
    includeUntracked: boolean,
  ): Promise<{ discarded: true; cwd: string }> {
    return this.transport.request(M.gitDiscard, { cwd, path, includeUntracked });
  }
  /** Creates a branch at HEAD and switches to it, keeping working-tree changes. */
  gitCreateBranch(cwd: string, name: string): Promise<{ created: true; branch: string }> {
    return this.transport.request(M.gitBranchCreate, { cwd, name });
  }
  listFiles(cwd: string, path: string): Promise<WorkspaceFileListResponse> {
    return this.transport.request(M.filesList, { cwd, path });
  }
  readFile(cwd: string, path: string): Promise<WorkspaceFileReadResponse> {
    return this.transport.request(M.filesRead, { cwd, path });
  }
  writeFile(
    cwd: string,
    path: string,
    content: string,
    revision: string,
  ): Promise<WorkspaceFileWriteResponse> {
    return this.transport.request(M.filesWrite, { cwd, path, content, revision });
  }
  /** Creates an empty file; rejects when something already exists at `path`. */
  createFile(cwd: string, path: string): Promise<WorkspaceFileWriteResponse> {
    return this.transport.request(M.filesCreate, { cwd, path });
  }
  renameFile(cwd: string, path: string, destination: string): Promise<{ ok: true }> {
    return this.transport.request(M.filesRename, { cwd, path, destination });
  }
  removeFile(cwd: string, path: string): Promise<{ ok: true }> {
    return this.transport.request(M.filesRemove, { cwd, path });
  }
}
