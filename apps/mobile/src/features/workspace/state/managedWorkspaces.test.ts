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
});
