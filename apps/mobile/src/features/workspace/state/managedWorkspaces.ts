import { atom, type Getter, type Setter } from 'jotai';

import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { activeProfileIdAtom } from '@shell/state/bridge/atoms';
import { normalizeWorkspacePath } from '../../chat/helpers/helpers';
import { screenAtom } from '../../chat/state/registry';
import { workspaceHostClientAtom } from '../api/atoms';
import { describeHostError } from '../api/errors';
import type {
  ManagedWorkspaceResponse,
  ManagedWorkspaceState,
  ManagedWorkspaceSummary,
} from '../api/protocol';
import { refreshWorkspaceRootsAtom, selectWorkspaceAtom } from './workspaceActions';
import { returnToChat } from './workspaceRouteNavigation';

/**
 * The workspace list for hosts with app-managed workspaces (`managedWorkspaces`), plus create,
 * rename, and delete. Each mutation reloads the list and keeps the new-chat workspace pointing at
 * a workspace that still exists. Failures surface in the picker as friendly copy.
 */
/**
 * True while the profile that started a workspace operation is still active. The new-chat default
 * belongs to the active profile, so a result that arrives after a profile switch must not land in
 * the other profile's default.
 */
function stillActive(get: Getter, profileId: string | null): boolean {
  return get(activeProfileIdAtom) === profileId;
}

export const managedWorkspacesAtom = screenAtom<ManagedWorkspaceSummary[] | null>(null);
export const managedWorkspacesLoadingAtom = screenAtom(false);
export const managedWorkspacesErrorAtom = screenAtom<string | null>(null);
/** Working-tree states and sizes by workspace path; a missing path has no known state yet. */
export const managedWorkspaceStatesAtom = screenAtom<
  Readonly<Record<string, ManagedWorkspaceState>>
>(() => ({}));

/**
 * Loads working-tree states and sizes after the list, so the picker never waits on a Git status
 * read or a size walk. The previous states stay on screen until the new ones arrive.
 */
export const loadManagedWorkspaceStatesAtom = atom(null, async (get, set): Promise<void> => {
  const host = get(workspaceHostClientAtom);
  if (!host) {
    return;
  }
  try {
    const { states } = await host.workspaceStates();
    set(managedWorkspaceStatesAtom, Object.fromEntries(states.map((state) => [state.path, state])));
  } catch {
    // State and size are supplementary; rows keep showing branch and remote without them.
  }
});

export const loadManagedWorkspacesAtom = atom(
  null,
  async (get, set, afterChange?: string): Promise<void> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return;
    }
    set(managedWorkspacesLoadingAtom, true);
    try {
      const { workspaces } = await host.listWorkspaces();
      set(managedWorkspacesAtom, workspaces);
      void set(loadManagedWorkspaceStatesAtom);
    } catch (error) {
      // After a confirmed change, say the change worked and only the refresh did not.
      set(
        managedWorkspacesErrorAtom,
        afterChange
          ? `${afterChange} The workspace list could not be refreshed.`
          : describeHostError(error, 'Could not load workspaces.'),
      );
    } finally {
      set(managedWorkspacesLoadingAtom, false);
    }
  },
);

/**
 * Shows a change the host has confirmed before the list is reloaded, so a failed refresh never
 * leaves a deleted workspace listed (or selectable), a renamed one under its old name, or a new one
 * missing. Its working-tree state is dropped until the reload measures it again.
 */
function applyConfirmedChange(
  get: Getter,
  set: Setter,
  change: { remove?: string; add?: ManagedWorkspaceResponse },
): void {
  const list = get(managedWorkspacesAtom);
  if (list) {
    const kept = list.filter((entry) => entry.path !== change.remove);
    const previous = list.find((entry) => entry.path === change.remove);
    const added = change.add
      ? [{ branch: previous?.branch ?? null, origin: previous?.origin ?? null, ...change.add }]
      : [];
    set(
      managedWorkspacesAtom,
      [...kept.filter((entry) => entry.path !== change.add?.path), ...added].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
  }
  if (change.remove) {
    const removed = change.remove;
    set(
      managedWorkspaceStatesAtom,
      Object.fromEntries(
        Object.entries(get(managedWorkspaceStatesAtom)).filter(([path]) => path !== removed),
      ),
    );
  }
}

/** Reloads after a confirmed change; a failed reload says the change itself succeeded. */
const reloadAfterChangeAtom = atom(null, async (_get, set, done: string): Promise<void> => {
  set(managedWorkspacesErrorAtom, null);
  await set(loadManagedWorkspacesAtom, done);
  // Recent workspaces elsewhere in the shell (drawer grouping, composer) read the roots list.
  void set(refreshWorkspaceRootsAtom, { force: true });
});

/** Uses a workspace for new chats, recording it with the host so first-run setup sees it. */
export const selectManagedWorkspaceAtom = atom(
  null,
  async (get, set, path: string): Promise<boolean> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return false;
    }
    const profileId = get(activeProfileIdAtom);
    try {
      await host.selectWorkspace(path);
    } catch (error) {
      set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not use that workspace.'));
      return false;
    }
    if (!stillActive(get, profileId)) {
      return false;
    }
    set(managedWorkspacesErrorAtom, null);
    set(selectWorkspaceAtom, path);
    return true;
  },
);

export const createManagedWorkspaceAtom = atom(
  null,
  async (get, set, name: string): Promise<boolean> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return false;
    }
    const profileId = get(activeProfileIdAtom);
    let created: ManagedWorkspaceResponse;
    try {
      created = await host.createWorkspace(name);
    } catch (error) {
      set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not create the workspace.'));
      return false;
    }
    if (!stillActive(get, profileId)) {
      return false;
    }
    applyConfirmedChange(get, set, { add: created });
    set(defaultStartCwdAtom, created.path);
    await set(reloadAfterChangeAtom, `Created ${created.name}.`);
    returnToChat();
    return true;
  },
);

export const renameManagedWorkspaceAtom = atom(
  null,
  async (get, set, { path, name }: { path: string; name: string }): Promise<boolean> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return false;
    }
    // Read before renaming: the host may already have repaired the default to another workspace
    // once the old path stopped resolving, but the user's choice is still this workspace.
    const wasDefault = normalizeWorkspacePath(get(defaultStartCwdAtom)) === path;
    const profileId = get(activeProfileIdAtom);
    let renamed: ManagedWorkspaceResponse;
    try {
      renamed = await host.renameWorkspace(path, name);
    } catch (error) {
      set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not rename the workspace.'));
      return false;
    }
    if (!stillActive(get, profileId)) {
      return true;
    }
    applyConfirmedChange(get, set, { remove: path, add: renamed });
    if (wasDefault) {
      set(defaultStartCwdAtom, renamed.path);
    }
    await set(reloadAfterChangeAtom, `Renamed to ${renamed.name}.`);
    return true;
  },
);

export const deleteManagedWorkspaceAtom = atom(
  null,
  async (get, set, path: string): Promise<boolean> => {
    const host = get(workspaceHostClientAtom);
    if (!host) {
      return false;
    }
    const profileId = get(activeProfileIdAtom);
    try {
      await host.deleteWorkspace(path);
    } catch (error) {
      set(managedWorkspacesErrorAtom, describeHostError(error, 'Could not delete the workspace.'));
      return false;
    }
    if (!stillActive(get, profileId)) {
      return true;
    }
    applyConfirmedChange(get, set, { remove: path });
    if (normalizeWorkspacePath(get(defaultStartCwdAtom)) === path) {
      set(defaultStartCwdAtom, null);
    }
    await set(reloadAfterChangeAtom, 'Deleted the workspace.');
    return true;
  },
);
