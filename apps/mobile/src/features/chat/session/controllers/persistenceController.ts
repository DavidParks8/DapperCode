import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import type { BridgeUiSurface } from '@bridge/types/types';
import {
  type ActivePlanState,
  CHAT_BRIDGE_UI_SURFACES_VERSION,
  CHAT_MODEL_PREFERENCES_VERSION,
  CHAT_PLAN_SNAPSHOTS_VERSION,
  type ChatModelPreference,
  ProfilePersistenceError,
  type ProfilePersistenceResource,
  type ProfilePersistenceStorage,
  WORKSPACE_FAVORITES_VERSION,
  getChatBridgeUiSurfacesPath,
  getChatModelPreferencesPath,
  getChatPlanSnapshotsPath,
  getWebProfilePersistenceKey,
  getWorkspaceFavoritesPath,
  parseChatBridgeUiSurfaces,
  parseChatModelPreferences,
  parseChatPlanSnapshots,
  parseWorkspaceFavoritePaths,
} from '../../helpers/helpers';

export type MainScreenStorage = ProfilePersistenceStorage;

export interface MainScreenPersistencePaths {
  modelPreferences: () => string | null;
  planSnapshots: () => string | null;
  bridgeUiSurfaces: () => string | null;
  workspaceFavorites: () => string | null;
}

export interface MainScreenPersistenceControllerOptions {
  profileId: string;
  storage?: MainScreenStorage;
  paths?: Partial<MainScreenPersistencePaths>;
  platform?: string;
  onPersistenceError?: (error: ProfilePersistenceError) => void;
}

const fileStorage: MainScreenStorage = {
  read: FileSystem.readAsStringAsync,
  write: FileSystem.writeAsStringAsync,
  exists: async (path) => (await FileSystem.getInfoAsync(path))?.exists === true,
};

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const webStorage: MainScreenStorage = {
  read: (key) => {
    const value = getWebStorage()?.getItem(key);
    if (value === null || value === undefined) {
      return Promise.reject(new Error('missing'));
    }
    return Promise.resolve(value);
  },
  write: (key, value) => {
    const storage = getWebStorage();
    if (!storage) {
      return Promise.reject(new Error('Browser storage is unavailable.'));
    }
    storage.setItem(key, value);
    return Promise.resolve();
  },
  exists: (key) => Promise.resolve(getWebStorage()?.getItem(key) != null),
};

type PersistedCollection =
  'modelPreferences' | 'planSnapshots' | 'bridgeUiSurfaces' | 'workspaceFavorites';

const RESOURCE_NAMES: Record<PersistedCollection, ProfilePersistenceResource> = {
  modelPreferences: 'model preferences',
  planSnapshots: 'plan snapshots',
  bridgeUiSurfaces: 'bridge UI surfaces',
  workspaceFavorites: 'workspace favorites',
};

function resolveStorage(
  storage: MainScreenStorage | undefined,
  platform: string,
): MainScreenStorage {
  return storage ?? (platform === 'web' ? webStorage : fileStorage);
}

function buildPersistencePaths(
  profileId: string,
  platform: string,
  overrides: Partial<MainScreenPersistencePaths>,
): MainScreenPersistencePaths {
  return {
    modelPreferences:
      overrides.modelPreferences ??
      createProfilePathResolver(profileId, platform, 'model-preferences.v1', () =>
        getChatModelPreferencesPath(profileId),
      ),
    planSnapshots:
      overrides.planSnapshots ??
      createProfilePathResolver(profileId, platform, 'plan-snapshots.v1', () =>
        getChatPlanSnapshotsPath(profileId),
      ),
    bridgeUiSurfaces:
      overrides.bridgeUiSurfaces ??
      createProfilePathResolver(profileId, platform, 'bridge-ui-surfaces.v1', () =>
        getChatBridgeUiSurfacesPath(profileId),
      ),
    workspaceFavorites:
      overrides.workspaceFavorites ??
      createProfilePathResolver(profileId, platform, 'workspace-favorites.v1', () =>
        getWorkspaceFavoritesPath(profileId),
      ),
  };
}

function createProfilePathResolver(
  profileId: string,
  platform: string,
  webName: string,
  nativePath: () => string | null,
): () => string | null {
  return () =>
    platform === 'web' ? getWebProfilePersistenceKey(webName, profileId) : nativePath();
}

export class MainScreenPersistenceController {
  private readonly storage: MainScreenStorage;
  private readonly paths: MainScreenPersistencePaths;
  private readonly onPersistenceError?: (error: ProfilePersistenceError) => void;
  private readonly writeChains = new Map<PersistedCollection, Promise<void>>();

  constructor(options: MainScreenPersistenceControllerOptions) {
    const { profileId, storage, paths = {}, platform = Platform.OS, onPersistenceError } = options;
    this.storage = resolveStorage(storage, platform);
    this.onPersistenceError = onPersistenceError;
    this.paths = buildPersistencePaths(profileId.trim(), platform, paths);
  }

  loadModelPreferences(): Promise<Record<string, ChatModelPreference>> {
    return this.read('modelPreferences', parseChatModelPreferences, {});
  }

  saveModelPreferences(entries: Record<string, ChatModelPreference>): Promise<void> {
    return this.write(
      'modelPreferences',
      {
        version: CHAT_MODEL_PREFERENCES_VERSION,
        entries,
      },
      true,
    );
  }

  loadPlanSnapshots(): Promise<Record<string, ActivePlanState>> {
    return this.read('planSnapshots', parseChatPlanSnapshots, {});
  }

  savePlanSnapshots(entries: Record<string, ActivePlanState>): Promise<void> {
    return this.write('planSnapshots', {
      version: CHAT_PLAN_SNAPSHOTS_VERSION,
      entries,
    });
  }

  loadBridgeUiSurfaces(): Promise<Record<string, BridgeUiSurface[]>> {
    return this.read('bridgeUiSurfaces', parseChatBridgeUiSurfaces, {});
  }

  saveBridgeUiSurfaces(entries: Record<string, BridgeUiSurface[]>): Promise<void> {
    return this.write('bridgeUiSurfaces', {
      version: CHAT_BRIDGE_UI_SURFACES_VERSION,
      entries,
    });
  }

  loadWorkspaceFavorites(): Promise<string[]> {
    return this.read('workspaceFavorites', parseWorkspaceFavoritePaths, []);
  }

  saveWorkspaceFavorites(paths: string[]): Promise<void> {
    return this.write(
      'workspaceFavorites',
      {
        version: WORKSPACE_FAVORITES_VERSION,
        paths,
      },
      true,
    );
  }

  private async read<T>(
    collection: PersistedCollection,
    parse: (raw: string) => T,
    fallback: T,
  ): Promise<T> {
    const path = this.paths[collection]();
    if (!path) {
      return fallback;
    }
    try {
      return parse(await this.storage.read(path));
    } catch {
      return fallback;
    }
  }

  private async write(
    collection: PersistedCollection,
    value: unknown,
    reliable = false,
  ): Promise<void> {
    const previous = this.writeChains.get(collection) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.performWrite(collection, value, reliable));
    this.writeChains.set(collection, write);
    void write.then(
      () => {
        if (this.writeChains.get(collection) === write) {
          this.writeChains.delete(collection);
        }
      },
      () => {
        if (this.writeChains.get(collection) === write) {
          this.writeChains.delete(collection);
        }
      },
    );
    return write;
  }

  private async performWrite(
    collection: PersistedCollection,
    value: unknown,
    reliable: boolean,
  ): Promise<void> {
    try {
      const path = this.paths[collection]();
      if (!path) {
        throw new Error('Persistence path is unavailable.');
      }
      await this.storage.write(path, JSON.stringify(value));
    } catch (cause) {
      if (!reliable) {
        // Plans and bridge surfaces are reconstructable snapshots; user-authored data is reliable.
        return;
      }
      const error = new ProfilePersistenceError(RESOURCE_NAMES[collection], 'write', { cause });
      this.reportError(error);
      throw error;
    }
  }

  private reportError(error: ProfilePersistenceError): void {
    this.onPersistenceError?.(error);
  }
}

function getWebStorage(): WebStorageLike | null {
  if (typeof globalThis !== 'object' || globalThis === null) {
    return null;
  }
  const storage = (globalThis as typeof globalThis & { localStorage?: Partial<WebStorageLike> })
    .localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null;
}
