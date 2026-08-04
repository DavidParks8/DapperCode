import { requireTestValue } from '@shared/testing/requireTestValue';
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  getInfoAsync: jest.fn(),
}));

import { MainScreenPersistenceController } from './persistenceController';
import type { MainScreenStorage } from './persistenceController';
import type { ProfilePersistenceError } from '../../helpers/helpers';

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
    });
    const second = new MainScreenPersistenceController({
      profileId: 'profile two',
      platform: 'web',
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
    expect(requireTestValue(errors[0], 'indexed test value').message).toContain(
      'available device storage',
    );
  });
});
