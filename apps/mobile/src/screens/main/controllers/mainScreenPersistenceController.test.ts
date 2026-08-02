jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  getInfoAsync: jest.fn(),
}));

import { MainScreenPersistenceController } from './mainScreenPersistenceController';
import type { MainScreenStorage } from './mainScreenPersistenceController';
import type { ProfilePersistenceError } from '../mainScreenHelpers';

function memoryStorage(initial: Record<string, string> = {}): MainScreenStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: jest.fn(async (path: string) => {
      const value = values.get(path);
      if (value === undefined) {
        throw new Error('missing');
      }
      return value;
    }),
    write: jest.fn(async (path: string, value: string) => {
      values.set(path, value);
    }),
    exists: jest.fn(async (path: string) => values.has(path)),
  };
}

describe('mainScreenPersistenceController', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('uses encoded profile-scoped native paths', async () => {
    const storage = memoryStorage();
    const controller = new MainScreenPersistenceController({
      profileId: ' bridge/a ',
      storage,
      platform: 'ios',
      migrateLegacy: false,
    });

    await controller.saveModelPreferences({
      thread: { modelId: 'model', effort: null, serviceTier: null, updatedAt: 'now' },
    });

    expect(storage.write).toHaveBeenCalledWith(
      'file:///documents/dappercode-profile-bridge%2Fa-chat-model-preferences.json',
      expect.any(String),
    );
  });

  it('isolates browser storage by profile', async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn((key: string) => values.get(key) ?? null),
        setItem: jest.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    const first = new MainScreenPersistenceController({
      profileId: 'profile/one',
      platform: 'web',
      migrateLegacy: false,
    });
    const second = new MainScreenPersistenceController({
      profileId: 'profile two',
      platform: 'web',
      migrateLegacy: false,
    });

    await first.saveModelPreferences({
      thread: { modelId: 'first', effort: null, serviceTier: null, updatedAt: 'now' },
    });
    await second.saveModelPreferences({
      thread: { modelId: 'second', effort: null, serviceTier: null, updatedAt: 'now' },
    });
    await first.savePlanSnapshots({});
    await first.saveBridgeUiSurfaces({});
    await first.saveWorkspaceFavorites(['/first/repo']);
    await second.saveWorkspaceFavorites(['/second/repo']);

    await expect(first.loadModelPreferences()).resolves.toMatchObject({
      thread: { modelId: 'first' },
    });
    await expect(second.loadModelPreferences()).resolves.toMatchObject({
      thread: { modelId: 'second' },
    });
    await expect(first.loadWorkspaceFavorites()).resolves.toEqual(['/first/repo']);
    await expect(second.loadWorkspaceFavorites()).resolves.toEqual(['/second/repo']);
    expect(values.has('dappercode.main-screen.profile.profile%2Fone.model-preferences.v1')).toBe(
      true,
    );
    expect(values.has('dappercode.main-screen.profile.profile%20two.model-preferences.v1')).toBe(
      true,
    );
    expect(values.has('dappercode.main-screen.profile.profile%2Fone.plan-snapshots.v1')).toBe(true);
    expect(values.has('dappercode.main-screen.profile.profile%2Fone.bridge-ui-surfaces.v1')).toBe(
      true,
    );
    expect(values.has('dappercode.main-screen.profile.profile%2Fone.workspace-favorites.v1')).toBe(
      true,
    );
  });

  it('migrates a legacy global collection to only the first active profile exactly once', async () => {
    const legacy = JSON.stringify({
      version: 1,
      entries: {
        thread: { modelId: 'legacy', effort: null, serviceTier: null, updatedAt: 'then' },
      },
    });
    const values = new Map<string, string>([
      ['dappercode.main-screen.model-preferences.v1', legacy],
    ]);
    const setItem = jest.fn((key: string, value: string) => values.set(key, value));
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn((key: string) => values.get(key) ?? null),
        setItem,
      },
    });

    const first = new MainScreenPersistenceController({
      profileId: 'first',
      platform: 'web',
    });
    await expect(first.loadModelPreferences()).resolves.toMatchObject({
      thread: { modelId: 'legacy' },
    });
    const second = new MainScreenPersistenceController({
      profileId: 'second',
      platform: 'web',
    });
    await expect(second.loadModelPreferences()).resolves.toEqual({});

    await first.loadModelPreferences();
    expect(
      setItem.mock.calls.filter(
        ([key]) => key === 'dappercode.main-screen.profile.first.model-preferences.v1',
      ),
    ).toHaveLength(1);
    expect(values.has('dappercode.main-screen.profile.second.model-preferences.v1')).toBe(false);
    expect(values.get('dappercode.main-screen.model-preferences.v1')).toBe(legacy);
  });

  it('keeps a claimed migration retryable after the target write fails', async () => {
    const storage = memoryStorage({
      '/legacy': JSON.stringify({
        version: 1,
        entries: { thread: { modelId: 'legacy', updatedAt: 'then' } },
      }),
    });
    const write = storage.write as jest.Mock;
    let failTargetWrite = true;
    write.mockImplementation(async (path: string, value: string) => {
      if (path === '/profile' && failTargetWrite) {
        failTargetWrite = false;
        throw new Error('target unavailable');
      }
      storage.values.set(path, value);
    });
    const errors: ProfilePersistenceError[] = [];
    const paths = {
      modelPreferences: () => '/profile',
      legacyModelPreferences: () => '/legacy',
      modelPreferencesMigrationMarker: () => '/marker',
    };
    const failed = new MainScreenPersistenceController({
      profileId: 'profile',
      storage,
      paths,
      onPersistenceError: (error) => errors.push(error),
    });
    await expect(failed.loadModelPreferences()).resolves.toEqual({});
    expect(errors[0]).toMatchObject({ operation: 'migrate', resource: 'model preferences' });
    expect(JSON.parse(storage.values.get('/marker')!)).toMatchObject({
      profileId: 'profile',
      complete: false,
    });
    expect(storage.values.get('/legacy')).toBeDefined();

    const retried = new MainScreenPersistenceController({ profileId: 'profile', storage, paths });
    await expect(retried.loadModelPreferences()).resolves.toMatchObject({
      thread: { modelId: 'legacy' },
    });
  });

  it('loads and saves every persisted collection', async () => {
    const storage = memoryStorage({
      '/models': JSON.stringify({ version: 1, entries: { thread: { modelId: 'm' } } }),
      '/plans': JSON.stringify({ version: 1, entries: {} }),
      '/surfaces': JSON.stringify({ version: 1, entries: {} }),
      '/favorites': JSON.stringify({ version: 1, paths: ['/repo'] }),
    });
    const controller = new MainScreenPersistenceController({
      profileId: 'profile',
      storage,
      migrateLegacy: false,
      paths: {
        modelPreferences: () => '/models',
        planSnapshots: () => '/plans',
        bridgeUiSurfaces: () => '/surfaces',
        workspaceFavorites: () => '/favorites',
      },
    });
    await expect(controller.loadModelPreferences()).resolves.toMatchObject({
      thread: { modelId: 'm' },
    });
    await expect(controller.loadPlanSnapshots()).resolves.toEqual({});
    await expect(controller.loadBridgeUiSurfaces()).resolves.toEqual({});
    await expect(controller.loadWorkspaceFavorites()).resolves.toEqual(['/repo']);
    await controller.savePlanSnapshots({});
    await controller.saveBridgeUiSurfaces({});
    await controller.saveWorkspaceFavorites(['/repo']);
    expect(storage.write).toHaveBeenCalledTimes(3);
  });

  it('reports reliable write failures while cache snapshots remain best effort', async () => {
    const cause = new Error('disk full');
    const storage = {
      read: jest.fn().mockRejectedValue(new Error('missing')),
      write: jest.fn().mockRejectedValue(cause),
      exists: jest.fn().mockResolvedValue(false),
    };
    const errors: ProfilePersistenceError[] = [];
    const controller = new MainScreenPersistenceController({
      profileId: 'profile',
      storage,
      migrateLegacy: false,
      paths: {
        modelPreferences: () => '/models',
        planSnapshots: () => '/plans',
      },
      onPersistenceError: (error) => errors.push(error),
    });

    await expect(controller.saveModelPreferences({})).rejects.toMatchObject({
      name: 'ProfilePersistenceError',
      operation: 'write',
      resource: 'model preferences',
    });
    await expect(controller.savePlanSnapshots({})).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('available device storage');
  });
});
