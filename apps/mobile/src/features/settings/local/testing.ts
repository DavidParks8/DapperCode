/* eslint-disable @typescript-eslint/require-await -- the fake mirrors the async runtime API */
import type { GitAccount, GitDeviceAuthorization } from '../../on-device/auth/strategy';
import { localModelDefinition } from '../../on-device/models/catalog';
import type { ModelDownloadSnapshot, ModelStorageSnapshot } from '../../on-device/models/downloads';
import type { LocalModelSessionSnapshot } from '../../on-device/models/session';
import type { DeviceMemory } from '../../on-device/models/types';
import type { LocalPreferences } from '../../on-device/runtime/preferences';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';

const GiB = 1024 ** 3;

export function downloadSnapshot(
  modelId: string,
  patch: Partial<ModelDownloadSnapshot> = {},
): ModelDownloadSnapshot {
  return {
    modelId,
    phase: 'not_downloaded',
    bytesWritten: 0,
    totalBytes: 0,
    bytesPerSecond: null,
    etaSeconds: null,
    verifiedBytes: 0,
    canResume: false,
    verificationPending: false,
    interrupted: false,
    file: null,
    error: null,
    ...patch,
  };
}

/**
 * A scriptable stand-in for `OnDeviceRuntime` that implements only what the local Settings pages
 * read, with the same slice-based subscriptions, so tests can drive downloads and model state.
 */
export class FakeSettingsRuntime {
  private listeners = new Set<{ listener: () => void; slices?: readonly OnDeviceRuntimeSlice[] }>();
  private versions = new Map<OnDeviceRuntimeSlice, number>();
  downloadsById = new Map<string, ModelDownloadSnapshot>();
  session: LocalModelSessionSnapshot = {
    phase: 'empty',
    modelId: null,
    progress: 0,
    error: null,
    contextTokens: null,
  };
  memory: DeviceMemory = { physicalBytes: 8 * GiB, availableBytes: 4 * GiB, isSimulator: false };
  storageValue: ModelStorageSnapshot = {
    usedBytes: 1_300_000_000,
    freeBytes: 42_000_000_000,
    capacityBytes: 128_000_000_000,
    models: [],
    reservedBytes: 0,
  };
  preferenceValue: LocalPreferences = {
    modelId: null,
    workspaceId: null,
    account: null,
    author: null,
  } as unknown as LocalPreferences;
  configured = true;
  pendingSignIn: {
    present: (code: GitDeviceAuthorization) => Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  readonly native = { getMemoryInfo: jest.fn(() => this.memory) };
  snapshotOf(id: string): ModelDownloadSnapshot {
    let value = this.downloadsById.get(id);
    if (!value) {
      value = downloadSnapshot(id);
      this.downloadsById.set(id, value);
    }
    return value;
  }

  readonly downloads = {
    snapshot: (id: string): ModelDownloadSnapshot => this.snapshotOf(id),
    storage: () => this.storageValue,
    refreshStorage: jest.fn(async () => this.storageValue),
    pause: jest.fn(async (id: string) => this.snapshotOf(id)),
    cancel: jest.fn(async (id: string) => this.snapshotOf(id)),
    verify: jest.fn(async (id: string) => this.snapshotOf(id)),
  };
  readonly models = {
    snapshot: () => this.session,
    resident: () =>
      this.session.modelId && (this.session.phase === 'ready' || this.session.phase === 'running')
        ? {
            model: localModelDefinition(this.session.modelId),
            contextTokens: this.session.contextTokens ?? 4096,
          }
        : null,
  };
  readonly authentication = {
    cancelSignIn: jest.fn(() => this.pendingSignIn?.reject(new Error('cancelled'))),
  };
  readonly selectModel = jest.fn(async (id: string): Promise<void> => {
    void id;
  });
  readonly unloadModel = jest.fn(async () => undefined);
  readonly removeModel = jest.fn(async (id: string): Promise<void> => {
    void id;
  });
  readonly downloadModel = jest.fn(async (id: string) => this.snapshotOf(id));
  readonly resumeModelDownload = jest.fn(async (id: string) => this.snapshotOf(id));
  readonly saveAuthor = jest.fn(async (author: { name: string; email: string }) => {
    this.setPreferences({ author: { name: author.name.trim(), email: author.email.trim() } });
  });
  readonly signOut = jest.fn(async () => {
    this.setPreferences({ account: null });
  });
  readonly signIn = jest.fn(
    (present: (code: GitDeviceAuthorization) => Promise<void>) =>
      new Promise<void>((resolve, reject) => {
        this.pendingSignIn = { present, resolve, reject };
      }),
  );

  authConfigured = () => this.configured;
  preferences = () => this.preferenceValue;

  subscribe = (listener: () => void, slices?: readonly OnDeviceRuntimeSlice[]) => {
    const entry = { listener, slices };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  };

  version = (slices?: readonly OnDeviceRuntimeSlice[]) =>
    (slices ?? [...this.versions.keys()]).reduce(
      (total, slice) => total + (this.versions.get(slice) ?? 0),
      0,
    );

  emit(...slices: OnDeviceRuntimeSlice[]) {
    for (const slice of slices) {
      this.versions.set(slice, (this.versions.get(slice) ?? 0) + 1);
    }
    for (const { listener, slices: wanted } of [...this.listeners]) {
      if (!wanted || wanted.some((slice) => slices.includes(slice))) {
        listener();
      }
    }
  }

  setDownload(id: string, patch: Partial<ModelDownloadSnapshot>) {
    this.downloadsById.set(id, { ...this.snapshotOf(id), ...patch });
    this.emit('downloads');
  }

  setSession(patch: Partial<LocalModelSessionSnapshot>) {
    this.session = { ...this.session, ...patch };
    this.emit('models');
  }

  setPreferences(patch: Partial<LocalPreferences>) {
    this.preferenceValue = { ...this.preferenceValue, ...patch };
    this.emit('preferences');
  }

  async completeSignIn(account: GitAccount) {
    this.setPreferences({ account });
    this.pendingSignIn?.resolve();
    this.pendingSignIn = null;
  }

  asRuntime(): OnDeviceRuntime {
    return this as unknown as OnDeviceRuntime;
  }
}
