import { atom } from 'jotai';

import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { normalizeWorkspacePath } from '../../chat/helpers/helpers';
import { screenAtom } from '../../chat/state/registry';
import { workspaceHostClientAtom } from '../api/atoms';
import { describeHostError } from '../api/errors';
import type { ManagedWorkspaceSummary } from '../api/protocol';
import { refreshWorkspaceRootsAtom } from './workspaceActions';
import { returnToChat } from './workspaceRouteNavigation';

/**
 * The workspace list for hosts with app-managed workspaces (`managedWorkspaces`), plus create,
 * rename, and delete. Each mutation reloads the list and keeps the new-chat workspace pointing at
 * a workspace that still exists. Failures surface in the picker as friendly copy.
 */
export const managedWorkspacesAtom = screenAtom<ManagedWorkspaceSummary[] | null>(null);
export const managedWorkspacesLoadingAtom = screenAtom(false);
export const managedWorkspacesErrorAtom = screenAtom<string | null>(null);

export const loadManagedWorkspacesAtom = atom(null, async (get, set): Promise<void> => {
  const host = get(workspaceHostClientAtom);
  if (!host) {
    return;
  }
  set(managedWorkspacesLoadingAtom, true);
  try {
    const { workspaces } = await host.listWorkspaces();
    set(managedWorkspacesAtom, workspaces);
  } catch (error) {
    set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not load workspaces.'));
  } finally {
    set(managedWorkspacesLoadingAtom, false);
  }
});

const reloadAfterChangeAtom = atom(null, async (_get, set): Promise<void> => {
  set(managedWorkspacesErrorAtom, null);
  await set(loadManagedWorkspacesAtom);
  // Recent workspaces elsewhere in the shell (drawer grouping, composer) read the roots list.
  void set(refreshWorkspaceRootsAtom, { force: true });
});

export const createManagedWorkspaceAtom = atom(
  null,
  async (get, set, name: string): Promise<boolean> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return false;
    }
    try {
      const created = await host.createWorkspace(name);
      set(defaultStartCwdAtom, created.path);
      await set(reloadAfterChangeAtom);
      returnToChat();
      return true;
    } catch (error) {
      set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not create the workspace.'));
      return false;
    }
  },
);

export const renameManagedWorkspaceAtom = atom(
  null,
  async (get, set, { path, name }: { path: string; name: string }): Promise<boolean> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return false;
    }
    try {
      const renamed = await host.renameWorkspace(path, name);
      if (normalizeWorkspacePath(get(defaultStartCwdAtom)) === path) {
        set(defaultStartCwdAtom, renamed.path);
      }
      await set(reloadAfterChangeAtom);
      return true;
    } catch (error) {
      set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not rename the workspace.'));
      return false;
    }
  },
);

export const deleteManagedWorkspaceAtom = atom(
  null,
  async (get, set, path: string): Promise<boolean> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return false;
    }
    try {
      await host.deleteWorkspace(path);
      if (normalizeWorkspacePath(get(defaultStartCwdAtom)) === path) {
        set(defaultStartCwdAtom, null);
      }
      await set(reloadAfterChangeAtom);
      return true;
    } catch (error) {
      set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not delete the workspace.'));
      return false;
    }
  },
);
