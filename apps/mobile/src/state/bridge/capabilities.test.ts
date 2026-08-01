import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities } from '../../api/types';
import { createDefaultAppStateData } from '../../appState';
import { appStateSnapshotAtom } from '../appState/atoms';
import { createTestStore } from '../testing';
import { apiClientAtom } from './atoms';
import {
  activeBridgeCapabilitiesResourceAtom,
  BRIDGE_CAPABILITIES_TTL_MS,
  refreshBridgeCapabilitiesAtom,
  revalidateBridgeCapabilitiesAtom,
} from './capabilities';

function capabilities(streamId: string, browserPreview = true): BridgeCapabilities {
  return {
    protocolVersion: 2,
    streamId,
    preferredAgentId: 'codex',
    activeAgentId: 'codex',
    agents: [],
    supportsByAgent: {},
    agUiEvents: true,
    supports: {
      reviewStart: true,
      turnSteer: true,
      commandOutputDelta: true,
      browserPreview,
      genericUiSurface: true,
    },
  };
}

function createCapabilitiesStore(readBridgeCapabilities: jest.Mock) {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = {
    activeProfileId: 'profile-1',
    profiles: [
      {
        id: 'profile-1',
        name: 'One',
        bridgeUrl: 'https://one.test',
        bridgeToken: 'one',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'profile-2',
        name: 'Two',
        bridgeUrl: 'https://two.test',
        bridgeToken: 'two',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  };
  const store = createTestStore({ data });
  store.set(apiClientAtom, { readBridgeCapabilities } as unknown as HostBridgeApiClient);
  return store;
}

function switchProfile(store: ReturnType<typeof createCapabilitiesStore>, profileId: string): void {
  const snapshot = store.get(appStateSnapshotAtom);
  store.set(appStateSnapshotAtom, {
    ...snapshot,
    data: {
      ...snapshot.data,
      bridgeProfiles: {
        ...snapshot.data.bridgeProfiles,
        activeProfileId: profileId,
      },
    },
  });
}

describe('bridge capabilities cache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serves a fresh cache hit without another read', async () => {
    const value = capabilities('one');
    const read = jest.fn().mockResolvedValue(value);
    const store = createCapabilitiesStore(read);
    jest.spyOn(Date, 'now').mockReturnValue(1_000);

    await store.set(revalidateBridgeCapabilitiesAtom);
    const cached = store.get(activeBridgeCapabilitiesResourceAtom);
    expect(cached).toMatchObject({
      value,
      fetchedAt: 1_000,
      refreshing: false,
      error: null,
    });

    jest.spyOn(Date, 'now').mockReturnValue(1_000 + BRIDGE_CAPABILITIES_TTL_MS - 1);
    expect(await store.set(revalidateBridgeCapabilitiesAtom)).toBe(value);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent reads', async () => {
    let resolveRequest!: (value: BridgeCapabilities) => void;
    const read = jest.fn(
      () =>
        new Promise<BridgeCapabilities>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const store = createCapabilitiesStore(read);

    const first = store.set(refreshBridgeCapabilitiesAtom);
    const second = store.set(refreshBridgeCapabilitiesAtom);
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.get(activeBridgeCapabilitiesResourceAtom).refreshing).toBe(true);

    const value = capabilities('deduped');
    resolveRequest(value);
    await expect(Promise.all([first, second])).resolves.toEqual([value, value]);
    expect(store.get(activeBridgeCapabilitiesResourceAtom).value).toBe(value);
  });

  it('retains stale data and its timestamp when refresh fails', async () => {
    const value = capabilities('stale', false);
    const read = jest.fn().mockResolvedValueOnce(value);
    const store = createCapabilitiesStore(read);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await store.set(revalidateBridgeCapabilitiesAtom);

    now.mockReturnValue(1_000 + BRIDGE_CAPABILITIES_TTL_MS);
    read.mockRejectedValueOnce(new Error('bridge offline'));
    await expect(store.set(revalidateBridgeCapabilitiesAtom)).resolves.toBe(value);
    expect(store.get(activeBridgeCapabilitiesResourceAtom)).toMatchObject({
      value,
      fetchedAt: 1_000,
      refreshing: false,
      error: 'bridge offline',
    });
  });

  it('isolates cached metadata by active profile', async () => {
    const one = capabilities('one');
    const two = capabilities('two');
    const read = jest.fn().mockResolvedValueOnce(one).mockResolvedValueOnce(two);
    const store = createCapabilitiesStore(read);

    await store.set(revalidateBridgeCapabilitiesAtom);
    switchProfile(store, 'profile-2');
    expect(store.get(activeBridgeCapabilitiesResourceAtom).value).toBeNull();
    await store.set(revalidateBridgeCapabilitiesAtom);
    expect(store.get(activeBridgeCapabilitiesResourceAtom).value).toBe(two);

    switchProfile(store, 'profile-1');
    expect(store.get(activeBridgeCapabilitiesResourceAtom).value).toBe(one);
    await store.set(revalidateBridgeCapabilitiesAtom);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
