import {
  appStateReducer,
  AppStatePersistenceError,
  importLegacyAppState,
  parsePersistedAppState,
  persistenceError,
  serializeAppState,
  type AppStateAction,
  type AppStateData,
  type AppStatePersistenceAdapter,
} from '../../appState';
import type { AppStore } from '../types';
import { appStatePersistenceAdapterAtom, appStateSnapshotAtom } from './atoms';

/**
 * Owns the mutable persistence machinery for the app-state atoms: a coalescing write loop,
 * a serialized durable-write chain, and the actions queued while a durable write is in flight.
 */
export class AppStatePersistenceCoordinator {
  private initializePromise: Promise<void> | null = null;
  private initializedSuccessfully = false;
  private pendingData: AppStateData | null = null;
  private writeLoop: Promise<void> | null = null;
  private durableChain: Promise<unknown> = Promise.resolve();
  private durableRequests = 0;
  private readonly queuedActions: AppStateAction[] = [];

  constructor(private readonly store: AppStore) {}

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.loadInitialState();
    }
    return this.initializePromise;
  }

  dispatch(action: AppStateAction): void {
    if (!this.store.get(appStateSnapshotAtom).loaded) {
      throw new Error('App state has not loaded.');
    }
    if (this.durableRequests > 0) {
      this.queuedActions.push(action);
      return;
    }
    this.publish(appStateReducer(this.data, action), null);
    this.queuePersistence(this.data);
  }

  dispatchDurable(action: AppStateAction): Promise<AppStateData> {
    this.durableRequests += 1;
    const operation = this.durableChain.then(() => this.applyDurable(action));
    this.durableChain = operation.catch(() => undefined);
    return operation;
  }

  async retryPersistence(): Promise<void> {
    if (!this.initializedSuccessfully) {
      this.initializePromise = null;
      await this.initialize();
      return;
    }
    if (this.writeLoop) {
      await this.writeLoop;
    }
    this.pendingData = this.data;
    this.publish(this.data, null);
    this.startWriteLoop();
    await this.flushPersistence();
  }

  async flushPersistence(): Promise<void> {
    if (this.pendingData && !this.writeLoop) {
      this.publish(this.data, null);
      this.startWriteLoop();
    }
    await this.writeLoop;
    const error = this.store.get(appStateSnapshotAtom).persistenceError;
    if (error) {
      throw error;
    }
  }

  private get data(): AppStateData {
    return this.store.get(appStateSnapshotAtom).data;
  }

  private get persistence(): AppStatePersistenceAdapter {
    const adapter = this.store.get(appStatePersistenceAdapterAtom);
    if (!adapter) {
      throw new Error('App-state persistence has not been configured.');
    }
    return adapter;
  }

  private async loadInitialState(): Promise<void> {
    try {
      const raw = await this.persistence.readCurrent().catch((error: unknown) => {
        throw persistenceError('read_failed', 'load', 'Could not load saved app state.', error);
      });
      if (raw !== null) {
        const data = parsePersistedAppState(raw);
        this.pendingData = null;
        this.initializedSuccessfully = true;
        this.publish(data, null, true);
        return;
      }
      await this.importLegacyState();
    } catch (error) {
      this.publish(
        this.data,
        error instanceof AppStatePersistenceError
          ? error
          : persistenceError('read_failed', 'load', 'Could not load saved app state.', error),
        true,
      );
    }
  }

  private async importLegacyState(): Promise<void> {
    const legacy = await this.persistence.readLegacy().catch((error: unknown) => {
      throw persistenceError(
        'read_failed',
        'import',
        'Could not import the existing app settings.',
        error,
      );
    });
    const data = importLegacyAppState(legacy);
    try {
      await this.persistence.writeCurrent(serializeAppState(data));
      this.pendingData = null;
      this.initializedSuccessfully = true;
      this.publish(data, null, true);
    } catch (error) {
      this.pendingData = data;
      this.publish(
        data,
        persistenceError(
          'write_failed',
          'import',
          'Imported settings could not be saved. Retry before changing connections.',
          error,
        ),
        true,
      );
    }
  }

  private async applyDurable(action: AppStateAction): Promise<AppStateData> {
    if (!this.store.get(appStateSnapshotAtom).loaded) {
      await this.initialize();
    }
    try {
      await this.flushPersistence();
      const nextData = appStateReducer(this.data, action);
      try {
        await this.persistence.writeCurrent(serializeAppState(nextData));
      } catch (error) {
        const typedError = persistenceError(
          'write_failed',
          'write',
          'The app-state change was not saved. Please retry.',
          error,
        );
        this.publish(this.data, typedError);
        throw typedError;
      }
      this.initializedSuccessfully = true;
      this.publish(nextData, null);
      return nextData;
    } finally {
      this.durableRequests -= 1;
      if (this.durableRequests === 0) {
        this.applyQueuedActions();
      }
    }
  }

  private applyQueuedActions(): void {
    if (this.queuedActions.length === 0) {
      return;
    }
    let data = this.data;
    for (const action of this.queuedActions.splice(0)) {
      data = appStateReducer(data, action);
    }
    this.publish(data, null);
    this.queuePersistence(data);
  }

  private queuePersistence(data: AppStateData): void {
    this.pendingData = data;
    this.startWriteLoop();
  }

  private startWriteLoop(): void {
    if (this.writeLoop || !this.pendingData) {
      return;
    }
    this.writeLoop = Promise.resolve()
      .then(async () => {
        while (this.pendingData) {
          const data = this.pendingData;
          this.pendingData = null;
          try {
            await this.persistence.writeCurrent(serializeAppState(data));
            this.initializedSuccessfully = true;
            this.publish(this.data, null);
          } catch (error) {
            this.pendingData = this.pendingData ?? data;
            this.publish(
              this.data,
              persistenceError(
                'write_failed',
                'write',
                'Settings could not be saved. Retry to persist the latest changes.',
                error,
              ),
            );
            return;
          }
        }
      })
      .finally(() => {
        this.writeLoop = null;
      });
  }

  private publish(
    data: AppStateData,
    error: AppStatePersistenceError | null,
    loaded = this.store.get(appStateSnapshotAtom).loaded,
  ): void {
    this.store.set(appStateSnapshotAtom, { loaded, data, persistenceError: error });
  }
}

const coordinators = new WeakMap<AppStore, AppStatePersistenceCoordinator>();

export function getAppStateCoordinator(store: AppStore): AppStatePersistenceCoordinator {
  const existing = coordinators.get(store);
  if (existing) {
    return existing;
  }
  const created = new AppStatePersistenceCoordinator(store);
  coordinators.set(store, created);
  return created;
}
