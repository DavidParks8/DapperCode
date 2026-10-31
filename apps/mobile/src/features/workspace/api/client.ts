import {
  WORKSPACE_HOST_METHODS as M,
  type CloneProgressResponse,
  type GitPullResponse,
  type ManagedWorkspaceResponse,
  type ManagedWorkspaceSummary,
  type WorkspaceFileListResponse,
  type WorkspaceFileReadResponse,
  type WorkspaceFileWriteResponse,
} from './protocol';

/** The part of `HostBridgeWsClient` the extensions need, so tests can pass a plain fake. */
export interface WorkspaceHostTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
}

/** Typed client for the workspace host extensions in `protocol.ts`. */
export class WorkspaceHostClient {
  constructor(private readonly transport: WorkspaceHostTransport) {}

  listWorkspaces(): Promise<{ workspaces: ManagedWorkspaceSummary[] }> {
    return this.transport.request(M.workspaceList, {});
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
  cloneProgress(): Promise<CloneProgressResponse> {
    return this.transport.request(M.cloneProgress, {});
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
