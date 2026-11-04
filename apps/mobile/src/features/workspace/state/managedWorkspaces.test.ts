jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));

import { HostBridgeApiClient } from '@bridge/client/client';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore } from '@shell/state/testing';

import {
  createManagedWorkspaceAtom,
  deleteManagedWorkspaceAtom,
  managedWorkspacesAtom,
  managedWorkspacesErrorAtom,
  renameManagedWorkspaceAtom,
  selectManagedWorkspaceAtom,
} from './managedWorkspaces';

/**
 * A transport whose first request (the action under test) settles only when the test resolves it;
 * later requests, such as reloading the workspace list, answer at once with an empty list.
 */
function heldTransport() {
  let resolve: (value: unknown) => void = () => undefined;
  let held = false;
  const request = jest.fn(() => {
    if (held) {
      return Promise.resolve({ workspaces: [] });
    }
    held = true;
    return new Promise((done) => {
      resolve = done;
    });
  });
  return {
    ws: { request } as unknown as HostBridgeWsClient,
    settle: (value: unknown) => resolve(value),
  };
}

function setup() {
  const { ws, settle } = heldTransport();
  const store = createBridgeTestStore({
    api: new HostBridgeApiClient({ ws, profileId: 'bridge-1' }),
    ws,
    bridgeProfileId: 'bridge-1',
    defaultStartCwd: '/Users/ada/repo',
  });
  store.set(localProfileAvailableAtom, true);
  const update = (patch: { activeProfileId?: string; localDefaultStartCwd?: string }) => {
    const snapshot = store.get(appStateSnapshotAtom);
    const { activeProfileId, ...settings } = patch;
    store.set(appStateSnapshotAtom, {
      ...snapshot,
      data: {
        ...snapshot.data,
        settings: { ...snapshot.data.settings, ...settings },
        bridgeProfiles: activeProfileId
          ? { ...snapshot.data.bridgeProfiles, activeProfileId }
          : snapshot.data.bridgeProfiles,
      },
    });
  };
  update({ activeProfileId: LOCAL_PROFILE_ID, localDefaultStartCwd: '/On this iPhone/Demo' });
  const settings = () => store.get(appStateSnapshotAtom).data.settings;
  return { store, settle, update, settings };
}

const ACTIONS = [
  {
    name: 'create',
    start: (store: ReturnType<typeof setup>['store']) =>
      store.set(createManagedWorkspaceAtom, 'Scratch'),
    result: { path: '/On this iPhone/Scratch', name: 'Scratch' },
  },
  {
    name: 'select',
    start: (store: ReturnType<typeof setup>['store']) =>
      store.set(selectManagedWorkspaceAtom, '/On this iPhone/Scratch'),
    result: { selected: true },
  },
  {
    name: 'rename',
    start: (store: ReturnType<typeof setup>['store']) =>
      store.set(renameManagedWorkspaceAtom, { path: '/On this iPhone/Demo', name: 'Renamed' }),
    result: { path: '/On this iPhone/Renamed', name: 'Renamed' },
  },
  {
    name: 'delete',
    start: (store: ReturnType<typeof setup>['store']) =>
      store.set(deleteManagedWorkspaceAtom, '/On this iPhone/Demo'),
    result: { deleted: true },
  },
];

describe('managed workspace actions', () => {
  it.each(ACTIONS)(
    'leave the desktop default alone when $name finishes after switching to a desktop',
    async ({ start, result }) => {
      const { store, settle, update, settings } = setup();
      const pending = start(store);
      update({ activeProfileId: 'bridge-1' });
      settle(result);
      await pending;
      expect(settings()).toMatchObject({
        defaultStartCwd: '/Users/ada/repo',
        localDefaultStartCwd: '/On this iPhone/Demo',
      });
    },
  );

  it('still updates the local default when the local profile stays open', async () => {
    const { store, settle, settings } = setup();
    const pending = store.set(createManagedWorkspaceAtom, 'Scratch');
    settle({ path: '/On this iPhone/Scratch', name: 'Scratch' });
    await pending;
    expect(settings()).toMatchObject({
      defaultStartCwd: '/Users/ada/repo',
      localDefaultStartCwd: '/On this iPhone/Scratch',
    });
  });

  describe('when the change succeeds but the list cannot be refreshed', () => {
    const demo = {
      path: '/On this iPhone/Demo',
      name: 'Demo',
      isRepository: true,
      branch: 'main',
      origin: null,
    };
    const scratch = {
      path: '/On this iPhone/Scratch',
      name: 'Scratch',
      isRepository: false,
      branch: null,
      origin: null,
    };

    /** Confirms every change, but the follow-up `workspace/list` reload fails. */
    function setupFailingRefresh() {
      const request = jest.fn((method: string, params: Record<string, unknown>) => {
        switch (method) {
          case 'workspace/create':
            return Promise.resolve({
              path: '/On this iPhone/New',
              name: 'New',
              isRepository: false,
            });
          case 'workspace/rename':
            return Promise.resolve({
              path: '/On this iPhone/Renamed',
              name: 'Renamed',
              isRepository: true,
            });
          case 'workspace/delete':
            return Promise.resolve({ ok: true, cwd: params['cwd'] });
          case 'workspace/list':
            return Promise.reject(new Error('The local transport is busy.'));
          default:
            return Promise.resolve({});
        }
      });
      const ws = { request } as unknown as HostBridgeWsClient;
      const store = createBridgeTestStore({
        api: new HostBridgeApiClient({ ws, profileId: 'bridge-1' }),
        ws,
        bridgeProfileId: 'bridge-1',
      });
      store.set(localProfileAvailableAtom, true);
      const snapshot = store.get(appStateSnapshotAtom);
      store.set(appStateSnapshotAtom, {
        ...snapshot,
        data: {
          ...snapshot.data,
          settings: { ...snapshot.data.settings, localDefaultStartCwd: demo.path },
          bridgeProfiles: { ...snapshot.data.bridgeProfiles, activeProfileId: LOCAL_PROFILE_ID },
        },
      });
      store.set(managedWorkspacesAtom, [demo, scratch]);
      const paths = () => store.get(managedWorkspacesAtom)?.map((entry) => entry.path);
      const settings = () => store.get(appStateSnapshotAtom).data.settings;
      return { store, paths, settings };
    }

    it('no longer lists or selects a deleted workspace, and says it was deleted', async () => {
      const { store, paths, settings } = setupFailingRefresh();
      await expect(store.set(deleteManagedWorkspaceAtom, demo.path)).resolves.toBe(true);
      expect(paths()).toEqual([scratch.path]);
      expect(settings().localDefaultStartCwd).toBeNull();
      expect(store.get(managedWorkspacesErrorAtom)).toBe(
        'Deleted the workspace. The workspace list could not be refreshed.',
      );
    });

    it('shows a renamed workspace under its new name and keeps it selected', async () => {
      const { store, settings } = setupFailingRefresh();
      await expect(
        store.set(renameManagedWorkspaceAtom, { path: demo.path, name: 'Renamed' }),
      ).resolves.toBe(true);
      expect(store.get(managedWorkspacesAtom)).toEqual([
        { ...demo, path: '/On this iPhone/Renamed', name: 'Renamed' },
        scratch,
      ]);
      expect(settings().localDefaultStartCwd).toBe('/On this iPhone/Renamed');
      expect(store.get(managedWorkspacesErrorAtom)).toBe(
        'Renamed to Renamed. The workspace list could not be refreshed.',
      );
    });

    it('lists and selects a created workspace', async () => {
      const { store, paths, settings } = setupFailingRefresh();
      await expect(store.set(createManagedWorkspaceAtom, 'New')).resolves.toBe(true);
      expect(paths()).toEqual([demo.path, '/On this iPhone/New', scratch.path]);
      expect(settings().localDefaultStartCwd).toBe('/On this iPhone/New');
      expect(store.get(managedWorkspacesErrorAtom)).toBe(
        'Created New. The workspace list could not be refreshed.',
      );
    });
  });
});
