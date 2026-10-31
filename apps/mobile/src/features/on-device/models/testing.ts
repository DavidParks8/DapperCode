/* eslint-disable @typescript-eslint/require-await -- the fakes mirror async native APIs */
import { localModelDefinition } from './catalog';
import type { NativeModelTransfer } from './downloadState';
import {
  ModelDownloadController,
  type ModelDownloadOptions,
  type ModelDownloadSnapshot,
  type ModelFilePort,
} from './downloads';
import type { LocalModelDefinition, LocalModelFile } from './types';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export const BYTES = 100;
export const POLL = 250;

export function idle(id: string): NativeModelTransfer {
  return {
    id,
    state: 'idle',
    bytesWritten: 0,
    totalBytes: 0,
    resumable: false,
    interrupted: false,
    error: null,
  };
}

/** Simulates the native background URL session and model file store. */
export function harness(
  ids = ['model-a', 'model-b', 'model-c'],
  options: ModelDownloadOptions = {},
) {
  const base = localModelDefinition('qwen3-1.7b-q4-k-m');
  const models: LocalModelDefinition[] = ids.map((id) => ({
    ...base,
    id,
    bytes: BYTES,
    downloadUrl: `https://models.example/${id}.gguf`,
  }));
  const transfers = new Map<string, NativeModelTransfer>();
  const staged = new Set<string>();
  const installed = new Map<string, LocalModelFile>();
  const verification = new Map<string, { completed: number; cancelled: boolean }>();
  let availableBytes = 1024 ** 3;
  const file = (id: string): LocalModelFile => ({
    id,
    sha256: base.sha256,
    bytes: BYTES,
    uri: `file:///models/${id}/ready/model.gguf`,
  });
  const native = {
    attachModelDownloads: jest.fn(async () =>
      [...transfers.values()].filter((transfer) => transfer.state === 'running'),
    ),
    startModelDownload: jest.fn(async (id: string, _url: string, totalBytes: number) => {
      const paused = transfers.get(id);
      const transfer: NativeModelTransfer = {
        ...idle(id),
        state: 'running',
        totalBytes,
        bytesWritten: paused?.state === 'paused' ? paused.bytesWritten : 0,
      };
      transfers.set(id, transfer);
      return transfer;
    }),
    pauseModelDownload: jest.fn(async (id: string) => {
      const current = transfers.get(id);
      if (current?.state === 'running') {
        transfers.set(id, { ...current, state: 'paused', resumable: true });
      }
      return transfers.get(id) ?? idle(id);
    }),
    cancelModelDownload: jest.fn(async (id: string) => {
      transfers.delete(id);
    }),
    getModelDownload: jest.fn((id: string) =>
      staged.has(id)
        ? { ...idle(id), state: 'completed' as const, bytesWritten: BYTES, totalBytes: BYTES }
        : (transfers.get(id) ?? idle(id)),
    ),
    getModelFilePaths: jest.fn(async (id: string) => ({
      partialUri: `file:///models/${id}/partial.gguf`,
      resumeUri: `file:///models/${id}/resume.json`,
      verificationBytes: staged.has(id) ? BYTES : null,
      availableBytes,
    })),
    getDownloadedModelFile: jest.fn(async (id: string) => installed.get(id) ?? null),
    finalizeModelDownload: jest.fn(async (id: string) => {
      staged.delete(id);
      installed.set(id, file(id));
      return file(id);
    }),
    removeModelFile: jest.fn(async (id: string) => {
      transfers.delete(id);
      staged.delete(id);
      installed.delete(id);
    }),
    getModelVerificationProgress: jest.fn((id: string) => {
      const progress = verification.get(id);
      return progress
        ? { active: true, completed: progress.completed, total: BYTES }
        : { active: false, completed: 0, total: 0 };
    }),
    cancelModelVerification: jest.fn((id: string) => {
      const progress = verification.get(id);
      if (progress) {
        progress.cancelled = true;
      }
    }),
    getModelStorageInfo: jest.fn(async () => ({
      usedBytes: installed.size * BYTES,
      freeBytes: availableBytes,
      capacityBytes: 8 * 1024 ** 3,
      models: [...installed.keys()].map((id) => ({ id, bytes: BYTES })),
    })),
  } satisfies ModelFilePort;
  const events: ModelDownloadSnapshot[] = [];
  const create = () =>
    new ModelDownloadController(
      models,
      native,
      (snapshot) => {
        if (snapshot) {
          events.push(snapshot);
        }
      },
      options,
    );
  return {
    models,
    native,
    events,
    transfers,
    staged,
    installed,
    verification,
    file,
    create,
    setAvailable: (bytes: number) => {
      availableBytes = bytes;
    },
    progress: (id: string, bytesWritten: number) => {
      const current = transfers.get(id);
      if (!current) {
        throw new Error(`No transfer for ${id}`);
      }
      transfers.set(id, { ...current, bytesWritten });
    },
    complete: (id: string) => {
      transfers.delete(id);
      staged.add(id);
    },
    interrupt: (id: string, bytesWritten: number) => {
      transfers.set(id, {
        ...idle(id),
        state: 'paused',
        bytesWritten,
        totalBytes: BYTES,
        resumable: true,
        interrupted: true,
        error: 'The network connection was lost.',
      });
    },
  };
}
