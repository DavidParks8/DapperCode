import type { HostBridgeApiClient } from '../../api/client';
import type { BrowserPreviewTargetSuggestion } from '../../api/types';
import { createDefaultAppStateData } from '../../appState';
import { appStateSnapshotAtom } from '../appState/atoms';
import { createTestStore } from '../testing';
import { apiClientAtom } from './atoms';
import {
  activeBrowserTargetsResourceAtom,
  BROWSER_TARGETS_TTL_MS,
  refreshBrowserTargetsAtom,
  revalidateBrowserTargetsAtom,
} from './browserTargets';

function suggestion(port: number, label = `Port ${port}`): BrowserPreviewTargetSuggestion {
  return {
    targetUrl: `http://127.0.0.1:${port}`,
    port,
    label,
  };
}

function response(suggestions: BrowserPreviewTargetSuggestion[]) {
  return {
    scannedAt: '2026-07-31T00:00:00.000Z',
    suggestions,
  };
}

function createBrowserTargetsStore(discoverBrowserPreviewTargets: jest.Mock) {
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
  store.set(apiClientAtom, {
    discoverBrowserPreviewTargets,
  } as unknown as HostBridgeApiClient);
  return store;
}

function switchProfile(
  store: ReturnType<typeof createBrowserTargetsStore>,
  profileId: string,
): void {
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

describe('browser target discovery cache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serves fresh cached suggestions until the short TTL expires', async () => {
    const first = [suggestion(5173, 'Vite')];
    const second = [suggestion(3000, 'Next')];
    const discover = jest
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(second));
    const store = createBrowserTargetsStore(discover);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    await store.set(revalidateBrowserTargetsAtom);
    now.mockReturnValue(1_000 + BROWSER_TARGETS_TTL_MS - 1);
    expect(await store.set(revalidateBrowserTargetsAtom)).toBe(first);
    expect(discover).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000 + BROWSER_TARGETS_TTL_MS);
    expect(await store.set(revalidateBrowserTargetsAtom)).toBe(second);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('deduplicates discovery requests already in flight', async () => {
    let resolveRequest!: (value: ReturnType<typeof response>) => void;
    const discover = jest.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const store = createBrowserTargetsStore(discover);

    const first = store.set(refreshBrowserTargetsAtom);
    const second = store.set(refreshBrowserTargetsAtom);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(store.get(activeBrowserTargetsResourceAtom).refreshing).toBe(true);

    const suggestions = [suggestion(5173)];
    resolveRequest(response(suggestions));
    await expect(Promise.all([first, second])).resolves.toEqual([suggestions, suggestions]);
    expect(store.get(activeBrowserTargetsResourceAtom).value).toBe(suggestions);
  });

  it('retains stale suggestions and their timestamp when revalidation fails', async () => {
    const suggestions = [suggestion(5173)];
    const discover = jest.fn().mockResolvedValueOnce(response(suggestions));
    const store = createBrowserTargetsStore(discover);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await store.set(revalidateBrowserTargetsAtom);

    now.mockReturnValue(1_000 + BROWSER_TARGETS_TTL_MS);
    discover.mockRejectedValueOnce(new Error('scan offline'));
    const revalidation = store.set(revalidateBrowserTargetsAtom);
    expect(store.get(activeBrowserTargetsResourceAtom)).toMatchObject({
      value: suggestions,
      fetchedAt: 1_000,
      refreshing: true,
      error: null,
    });
    await expect(revalidation).resolves.toBe(suggestions);
    expect(store.get(activeBrowserTargetsResourceAtom)).toMatchObject({
      value: suggestions,
      fetchedAt: 1_000,
      refreshing: false,
      error: 'scan offline',
    });
  });

  it('forces an explicit refresh even while cached data is fresh', async () => {
    const first = [suggestion(5173)];
    const second = [suggestion(3000)];
    const discover = jest
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(second));
    const store = createBrowserTargetsStore(discover);
    jest.spyOn(Date, 'now').mockReturnValue(1_000);

    await store.set(revalidateBrowserTargetsAtom);
    expect(await store.set(refreshBrowserTargetsAtom)).toBe(second);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(store.get(activeBrowserTargetsResourceAtom).value).toBe(second);
  });

  it('isolates cached suggestions by active profile', async () => {
    const one = [suggestion(3001, 'One')];
    const two = [suggestion(3002, 'Two')];
    const discover = jest
      .fn()
      .mockResolvedValueOnce(response(one))
      .mockResolvedValueOnce(response(two));
    const store = createBrowserTargetsStore(discover);

    await store.set(revalidateBrowserTargetsAtom);
    switchProfile(store, 'profile-2');
    expect(store.get(activeBrowserTargetsResourceAtom).value).toBeNull();
    await store.set(revalidateBrowserTargetsAtom);
    expect(store.get(activeBrowserTargetsResourceAtom).value).toBe(two);

    switchProfile(store, 'profile-1');
    expect(store.get(activeBrowserTargetsResourceAtom).value).toBe(one);
    await store.set(revalidateBrowserTargetsAtom);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
