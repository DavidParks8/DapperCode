import type { GitCloneResponse } from '@bridge/types/types';
import {
  WORKSPACE_HOST_METHODS as M,
  type ManagedWorkspaceResponse,
  type ManagedWorkspaceSummary,
  type WorkspaceFileListResponse,
  type WorkspaceFileReadResponse,
} from '../../workspace/api/protocol';
import { httpsRemoteError } from '../../workspace/api/remoteUrl';
import { isOnDeviceNativeError } from '../native/services.errors';
import type { LocalWorkspace } from '../workspaces/types';
import { LOCAL_RPC_ERROR, LocalRpcError } from './errors';
import { readParam, type RpcParams } from './params';
import type { LocalAgentPort } from './port';
import { LOCAL_WORKSPACE_ROOT, localWorkspacePaths } from './wire';

/**
 * `bridge/git/clone` plus the workspace host extensions this transport answers
 * (`features/workspace/api/protocol.ts`).
 */
export const LOCAL_WORKSPACE_METHODS = [
  'bridge/git/clone',
  M.workspaceList,
  M.workspaceSelect,
  M.gitFetch,
  M.gitPull,
  M.gitInit,
  M.gitDiscard,
  M.gitBranchCreate,
  M.cloneProgress,
  M.cloneCancel,
  M.workspaceCreate,
  M.workspaceRename,
  M.workspaceDelete,
  M.workspaceChangeToken,
  M.filesList,
  M.filesRead,
  M.filesWrite,
  M.filesCreate,
  M.filesRename,
  M.filesRemove,
] as const;

/** Entries returned per folder; the Files screen says when a folder has more. */
export const LOCAL_FILE_LIST_LIMIT = 500;
/** Largest single native read. Bigger files open read-only with their total size. */
export const LOCAL_FILE_READ_LIMIT = 65_536;

type ResolveWorkspace = (params: RpcParams) => Promise<{ id: string; cwd: string }>;

function invalid(message: string, extra: Record<string, unknown> = {}): LocalRpcError {
  return new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, message, {
    error: 'on_device_failed',
    ...extra,
  });
}

/** Workspace-relative path with no leading, trailing, or doubled separators. */
export function relativeFilePath(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
}

function requireName(params: RpcParams, key: string, message: string): string {
  const value = readParam(params, key);
  if (!value) {
    throw invalid(message);
  }
  return value;
}

function presentedPath(port: LocalAgentPort, workspace: LocalWorkspace): string {
  return (
    localWorkspacePaths(port.workspaces()).get(workspace.id) ??
    `${LOCAL_WORKSPACE_ROOT}/${workspace.name}`
  );
}

function managedWorkspace(
  port: LocalAgentPort,
  workspace: LocalWorkspace,
): ManagedWorkspaceResponse {
  return {
    path: presentedPath(port, workspace),
    name: workspace.name,
    isRepository: workspace.isRepository,
  };
}

/**
 * Workspace lifecycle, clone, and file handlers for the workspace host extensions
 * (`features/workspace/api/protocol.ts`) plus `bridge/git/clone`.
 */
export function createLocalWorkspaceHandlers(port: LocalAgentPort, workspace: ResolveWorkspace) {
  return {
    'bridge/git/clone': async (params: RpcParams): Promise<GitCloneResponse> => {
      const url = readParam(params, 'url') ?? '';
      const urlError = httpsRemoteError(url);
      if (urlError) {
        throw invalid(urlError);
      }
      const parent = readParam(params, 'parentPath')?.replace(/\/+$/u, '') ?? null;
      if (parent && parent !== LOCAL_WORKSPACE_ROOT) {
        throw invalid('Repositories on this iPhone are cloned into their own workspace.');
      }
      const name = requireName(params, 'directoryName', 'Enter a workspace name.');
      const cloned = await port.workspaceAdmin.clone(name, url);
      return {
        code: 0,
        stdout: '',
        stderr: '',
        cloned: true,
        cwd: presentedPath(port, cloned),
        url,
      };
    },
    [M.workspaceList]: async (): Promise<{ workspaces: ManagedWorkspaceSummary[] }> => {
      await port.refreshWorkspaces();
      const paths = localWorkspacePaths(port.workspaces());
      const workspaces = await Promise.all(
        port.workspaces().map(async (entry) => {
          const metadata = entry.isRepository
            ? await port.workspaceAdmin
                .metadata(entry.id)
                .catch(() => ({ branch: null, origin: null }))
            : { branch: null, origin: null };
          return {
            path: paths.get(entry.id) ?? `${LOCAL_WORKSPACE_ROOT}/${entry.name}`,
            name: entry.name,
            isRepository: entry.isRepository,
            ...metadata,
          };
        }),
      );
      return {
        workspaces: workspaces.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        ),
      };
    },
    [M.workspaceSelect]: async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      await port.workspaceAdmin.select(id);
      return { ok: true, cwd };
    },
    [M.cloneProgress]: () => port.workspaceAdmin.cloneProgress(),
    [M.cloneCancel]: () => {
      port.workspaceAdmin.cancelTransfer();
      return { ok: true };
    },
    [M.workspaceCreate]: async (params: RpcParams) => {
      const name = requireName(params, 'name', 'Enter a workspace name.');
      return managedWorkspace(port, await port.workspaceAdmin.create(name));
    },
    [M.workspaceRename]: async (params: RpcParams) => {
      const { id } = await workspace(params);
      const name = requireName(params, 'name', 'Enter a workspace name.');
      return managedWorkspace(port, await port.workspaceAdmin.rename(id, name));
    },
    [M.workspaceDelete]: async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      await port.workspaceAdmin.delete(id);
      return { ok: true, cwd };
    },
    [M.workspaceChangeToken]: async (params: RpcParams) => {
      const { id } = await workspace(params);
      return { token: await port.workspaceAdmin.changeToken(id) };
    },
    [M.filesList]: async (params: RpcParams): Promise<WorkspaceFileListResponse> => {
      const { id, cwd } = await workspace(params);
      const path = relativeFilePath(params['path']);
      const listing = await port.files.list(id, path, LOCAL_FILE_LIST_LIMIT);
      return {
        cwd,
        path,
        truncated: listing.truncated,
        limit: LOCAL_FILE_LIST_LIMIT,
        entries: listing.entries.map((entry) => ({
          ...entry,
          path: path ? `${path}/${entry.name}` : entry.name,
        })),
      };
    },
    [M.filesRead]: async (params: RpcParams): Promise<WorkspaceFileReadResponse> => {
      const { id } = await workspace(params);
      const path = relativeFilePath(params['path']);
      if (!path) {
        throw invalid('Choose a file to open.');
      }
      const read = await port.files.read(id, path, 0, LOCAL_FILE_READ_LIMIT);
      return {
        path,
        content: read.content,
        revision: read.revision,
        truncated: read.nextOffset !== null,
        totalBytes: read.totalBytes,
      };
    },
    [M.filesWrite]: async (params: RpcParams) => {
      const { id } = await workspace(params);
      const path = relativeFilePath(params['path']);
      const revision = readParam(params, 'revision');
      if (!path || !revision || typeof params['content'] !== 'string') {
        throw invalid('Open the file before saving it.');
      }
      return { path, revision: await port.files.write(id, path, params['content'], revision) };
    },
    [M.filesCreate]: async (params: RpcParams) => {
      const { id } = await workspace(params);
      const path = relativeFilePath(params['path']);
      if (!path) {
        throw invalid('Enter a file name.');
      }
      try {
        return { path, revision: await port.files.write(id, path, '', null) };
      } catch (error) {
        if (isOnDeviceNativeError(error, 'FILE_REVISION_CONFLICT')) {
          throw new LocalRpcError(
            LOCAL_RPC_ERROR.serverError,
            'Something with that name already exists here.',
            { error: 'on_device_failed', nativeCode: 'PATH_EXISTS' },
          );
        }
        throw error;
      }
    },
    [M.filesRename]: async (params: RpcParams) => {
      const { id } = await workspace(params);
      const path = relativeFilePath(params['path']);
      const destination = relativeFilePath(params['destination']);
      if (!path || !destination) {
        throw invalid('Enter a new name.');
      }
      await port.files.rename(id, path, destination);
      return { ok: true };
    },
    [M.filesRemove]: async (params: RpcParams) => {
      const { id } = await workspace(params);
      const path = relativeFilePath(params['path']);
      if (!path) {
        throw invalid('The workspace folder itself cannot be deleted here.');
      }
      await port.files.remove(id, path);
      return { ok: true };
    },
  } satisfies Record<string, (params: RpcParams) => unknown>;
}
