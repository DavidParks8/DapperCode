import type {
  LocalDirectoryListing,
  LocalFileRead,
  LocalSearchResult,
  LocalWorkspace,
} from '../workspaces/types';
import type { DeviceMemory, LocalModelFile, LocalModelPaths } from '../models/types';

export const ON_DEVICE_NATIVE_API_VERSION = 5;

export interface OnDeviceNativeServices {
  getAPIVersion(): number;
  getMemoryInfo(): DeviceMemory;
  cancelGitTransfer(): void;
  getGitTransferProgress(): {
    active: boolean;
    cancelled: boolean;
    completed: number;
    total: number;
  };
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
  searchWorkspaceFiles(id: string, query: string): Promise<LocalSearchResult>;
  getModelFilePaths(id: string): Promise<LocalModelPaths>;
  getDownloadedModelFile(id: string): Promise<LocalModelFile | null>;
  finalizeModelDownload(id: string, sha256: string, bytes: number): Promise<LocalModelFile>;
  removeModelFile(id: string): Promise<void>;
  readRuntimeDocument(name: string): Promise<string | null>;
  writeRuntimeDocument(name: string, content: string): Promise<void>;
  listRuntimeDocuments(prefix: string): Promise<string[]>;
  removeRuntimeDocument(name: string): Promise<void>;
  getWorkspaceGitStatus(id: string): Promise<GitStatusResponse>;
  getWorkspaceGitDiff(id: string, maximumBytes: number | null): Promise<GitDiffResponse>;
  getWorkspaceGitHistory(id: string): Promise<GitHistoryResponse>;
  getWorkspaceGitBranches(id: string): Promise<GitBranchesResponse>;
  stageWorkspaceGit(id: string, path: string | null): Promise<void>;
  unstageWorkspaceGit(id: string, path: string | null): Promise<void>;
  commitWorkspaceGit(id: string, message: string, name: string, email: string): Promise<string>;
  switchWorkspaceGitBranch(id: string, branch: string): Promise<void>;
  getWorkspaceGitOrigin(id: string): Promise<string>;
  pushWorkspaceGit(id: string, credentialRef: string | null): Promise<void>;
}
import type {
  GitBranchesResponse,
  GitDiffResponse,
  GitHistoryResponse,
  GitStatusResponse,
} from '@bridge/types/types';
