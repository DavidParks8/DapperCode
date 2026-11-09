import type { FileSystemListResponse, WorkspaceListResponse } from '@bridge/types/types';
import type { LocalThread } from '../runtime/types';
import type { LocalWorkspace } from '../workspaces/types';
import { LOCAL_WORKSPACE_ROOT, localWorkspacePaths } from './wire';

/** `bridge/workspaces/list`: every local workspace with its chat count and latest activity. */
export function localWorkspaceList(
  workspaces: readonly LocalWorkspace[],
  threads: readonly LocalThread[],
): WorkspaceListResponse {
  return {
    bridgeRoot: LOCAL_WORKSPACE_ROOT,
    allowOutsideRootCwd: false,
    workspaces: [...localWorkspacePaths(workspaces)].map(([id, path]) => {
      const owned = threads.filter((thread) => thread.workspaceId === id);
      return {
        path,
        chatCount: owned.length,
        ...(owned[0] ? { updatedAt: owned[0].updatedAt } : {}),
      };
    }),
  };
}

/** `bridge/fs/list`: the virtual root lists workspaces; nothing below it is browsable here. */
export function localFilesystemList(
  workspaces: readonly LocalWorkspace[],
  path: string | null,
): FileSystemListResponse {
  const atRoot = !path || path === LOCAL_WORKSPACE_ROOT;
  const entries = atRoot
    ? [...localWorkspacePaths(workspaces)].map(([id, entryPath]) => ({
        name: entryPath.slice(LOCAL_WORKSPACE_ROOT.length + 1),
        path: entryPath,
        kind: 'directory',
        hidden: false,
        selectable: true,
        isGitRepo: workspaces.find((workspace) => workspace.id === id)?.isRepository === true,
      }))
    : [];
  return {
    bridgeRoot: LOCAL_WORKSPACE_ROOT,
    path: atRoot ? LOCAL_WORKSPACE_ROOT : path,
    parentPath: atRoot ? null : LOCAL_WORKSPACE_ROOT,
    entries,
    truncated: false,
    totalEntries: entries.length,
    omittedEntries: 0,
    maxEntries: entries.length,
  };
}
