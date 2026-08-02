import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import type { BridgeUiSurface } from '../../../api/types';
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
  getLegacyChatBridgeUiSurfacesPath,
  getLegacyChatModelPreferencesPath,
  getLegacyChatPlanSnapshotsPath,
  getLegacyWorkspaceFavoritesPath,
  getPersistenceMigrationMarkerPath,
  getWebPersistenceMigrationMarkerKey,
  getWebProfilePersistenceKey,
  getWorkspaceFavoritesPath,
  migrateLegacyPersistenceEntry,
  parseChatBridgeUiSurfaces,
  parseChatModelPreferences,
  parseChatPlanSnapshots,
  parseWorkspaceFavoritePaths,
} from '../mainScreenHelpers';

export type MainScreenStorage = ProfilePersistenceStorage;

export interface MainScreenPersistencePaths {
  modelPreferences: () => string | null;
  planSnapshots: () => string | null;
  bridgeUiSurfaces: () => string | null;
  workspaceFavorites: () => string | null;
  legacyModelPreferences: () => string | null;
  legacyPlanSnapshots: () => string | null;
  legacyBridgeUiSurfaces: () => string | null;
  legacyWorkspaceFavorites: () => string | null;
  modelPreferencesMigrationMarker: () => string | null;
  planSnapshotsMigrationMarker: () => string | null;
  bridgeUiSurfacesMigrationMarker: () => string | null;
  workspaceFavoritesMigrationMarker: () => string | null;
}

export interface MainScreenPersistenceControllerOptions {
  profileId: string;
  storage?: MainScreenStorage;
  paths?: Partial<MainScreenPersistencePaths>;
  platform?: string;
  migrateLegacy?: boolean;
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
  read: async (key) => {
    const value = getWebStorage()?.getItem(key);
    if (value === null || value === undefined) throw new Error('missing');
    return value;
  },
  write: async (key, value) => {
    const storage = getWebStorage();
    if (!storage) throw new Error('Browser storage is unavailable.');
    storage.setItem(key, value);
  },
  exists: async (key) => getWebStorage()?.getItem(key) != null,
};

const WEB_LEGACY_PATHS = {
  modelPreferences: 'dappercode.main-screen.model-preferences.v1',
  planSnapshots: 'dappercode.main-screen.plan-snapshots.v1',
  bridgeUiSurfaces: 'dappercode.main-screen.bridge-ui-surfaces.v1',
  workspaceFavorites: 'dappercode.main-screen.workspace-favorites.v1',
} as const;

type PersistedCollection =
  'modelPreferences' | 'planSnapshots' | 'bridgeUiSurfaces' | 'workspaceFavorites';

const RESOURCE_NAMES: Record<PersistedCollection, ProfilePersistenceResource> = {
  modelPreferences: 'model preferences',
  planSnapshots: 'plan snapshots',
  bridgeUiSurfaces: 'bridge UI surfaces',
  workspaceFavorites: 'workspace favorites',
};

const MIGRATION_KEYS: Record<PersistedCollection, string> = {
  modelPreferences: 'model-preferences',
  planSnapshots: 'plan-snapshots',
  bridgeUiSurfaces: 'bridge-ui-surfaces',
  workspaceFavorites: 'workspace-favorites',
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
    legacyModelPreferences:
      overrides.legacyModelPreferences ??
      createLegacyPathResolver(
        platform,
        WEB_LEGACY_PATHS.modelPreferences,
        getLegacyChatModelPreferencesPath,
      ),
    legacyPlanSnapshots:
      overrides.legacyPlanSnapshots ??
      createLegacyPathResolver(
        platform,
        WEB_LEGACY_PATHS.planSnapshots,
        getLegacyChatPlanSnapshotsPath,
      ),
    legacyBridgeUiSurfaces:
      overrides.legacyBridgeUiSurfaces ??
      createLegacyPathResolver(
        platform,
        WEB_LEGACY_PATHS.bridgeUiSurfaces,
        getLegacyChatBridgeUiSurfacesPath,
      ),
    legacyWorkspaceFavorites:
      overrides.legacyWorkspaceFavorites ??
      createLegacyPathResolver(
        platform,
        WEB_LEGACY_PATHS.workspaceFavorites,
        getLegacyWorkspaceFavoritesPath,
      ),
    modelPreferencesMigrationMarker:
      overrides.modelPreferencesMigrationMarker ??
      createMarkerPathResolver(platform, 'modelPreferences'),
    planSnapshotsMigrationMarker:
      overrides.planSnapshotsMigrationMarker ?? createMarkerPathResolver(platform, 'planSnapshots'),
    bridgeUiSurfacesMigrationMarker:
      overrides.bridgeUiSurfacesMigrationMarker ??
      createMarkerPathResolver(platform, 'bridgeUiSurfaces'),
    workspaceFavoritesMigrationMarker:
      overrides.workspaceFavoritesMigrationMarker ??
      createMarkerPathResolver(platform, 'workspaceFavorites'),
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

function createLegacyPathResolver(
  platform: string,
  webKey: string,
  nativePath: () => string | null,
): () => string | null {
  return () => (platform === 'web' ? webKey : nativePath());
}

function createMarkerPathResolver(
  platform: string,
  collection: PersistedCollection,
): () => string | null {
  return () =>
    platform === 'web'
      ? getWebPersistenceMigrationMarkerKey(MIGRATION_KEYS[collection])
      : getPersistenceMigrationMarkerPath(MIGRATION_KEYS[collection]);
}

export class MainScreenPersistenceController {
  private readonly storage: MainScreenStorage;
  private readonly paths: MainScreenPersistencePaths;
  private readonly profileId: string;
  private readonly migrateLegacy: boolean;
  private readonly onPersistenceError?: (error: ProfilePersistenceError) => void;
  private readonly migrated = new Set<PersistedCollection>();
  private readonly writeChains = new Map<PersistedCollection, Promise<void>>();

  constructor(options: MainScreenPersistenceControllerOptions) {
    const {
      profileId,
      storage,
      paths = {},
      platform = Platform.OS,
      migrateLegacy = true,
      onPersistenceError,
    } = options;
    this.profileId = profileId.trim();
    this.storage = resolveStorage(storage, platform);
    this.migrateLegacy = migrateLegacy;
    this.onPersistenceError = onPersistenceError;
    this.paths = buildPersistencePaths(this.profileId, platform, paths);
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

  private async migrate(collection: PersistedCollection): Promise<void> {
    if (!this.migrateLegacy || this.migrated.has(collection)) return;

    const suffix = collection[0].toUpperCase() + collection.slice(1);
    await migrateLegacyPersistenceEntry({
      storage: this.storage,
      profileId: this.profileId,
      targetPath: this.paths[collection](),
      legacyPath: this.paths[`legacy${suffix}` as keyof MainScreenPersistencePaths](),
      markerPath: this.paths[`${collection}MigrationMarker` as keyof MainScreenPersistencePaths](),
    });
    this.migrated.add(collection);
  }

  private async read<T>(
    collection: PersistedCollection,
    parse: (raw: string) => T,
    fallback: T,
  ): Promise<T> {
    try {
      await this.migrate(collection);
    } catch (cause) {
      this.reportError(
        new ProfilePersistenceError(RESOURCE_NAMES[collection], 'migrate', { cause }),
      );
      return fallback;
    }

    const path = this.paths[collection]();
    if (!path) return fallback;
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
        if (this.writeChains.get(collection) === write) this.writeChains.delete(collection);
      },
      () => {
        if (this.writeChains.get(collection) === write) this.writeChains.delete(collection);
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
      await this.migrate(collection);
      const path = this.paths[collection]();
      if (!path) throw new Error('Persistence path is unavailable.');
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
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const storage = (globalThis as typeof globalThis & { localStorage?: Partial<WebStorageLike> })
    .localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? (storage as WebStorageLike)
    : null;
}
