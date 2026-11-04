import type { OnDeviceNativeServices } from '../native/services.types';
import type { LocalModelDefinition, LocalModelFile } from './types';

export type NativeModelTransferState = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

/** Native background-session state for one model's transfer. */
export interface NativeModelTransfer {
  id: string;
  state: NativeModelTransferState;
  bytesWritten: number;
  totalBytes: number;
  resumable: boolean;
  /** The system stopped the transfer (for example a force quit or network loss), not the user. */
  interrupted: boolean;
  error: string | null;
}

export interface NativeModelVerificationProgress {
  active: boolean;
  completed: number;
  total: number;
}

export interface NativeModelStorageInfo {
  usedBytes: number;
  freeBytes: number;
  capacityBytes: number;
  models: { id: string; bytes: number }[];
}

export type ModelDownloadPhase =
  | 'loading'
  | 'not_downloaded'
  | 'preparing'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'ready'
  | 'error';

export interface ModelDownloadSnapshot {
  modelId: string;
  phase: ModelDownloadPhase;
  bytesWritten: number;
  totalBytes: number;
  /** Smoothed transfer (or verification) rate; null until enough samples exist. */
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  /** Bytes hashed so far while `phase` is `verifying`. */
  verifiedBytes: number;
  canResume: boolean;
  verificationPending: boolean;
  /** The system, not the user, stopped this work; `resumeLifecyclePaused()` continues it. */
  interrupted: boolean;
  file: LocalModelFile | null;
  error: string | null;
}

export interface ModelStorageSnapshot extends NativeModelStorageInfo {
  /** Bytes still needed by queued and running transfers. */
  reservedBytes: number;
}

export type ModelFilePort = Pick<
  OnDeviceNativeServices,
  | 'getModelFilePaths'
  | 'getDownloadedModelFile'
  | 'finalizeModelDownload'
  | 'removeModelFile'
  | 'attachModelDownloads'
  | 'startModelDownload'
  | 'pauseModelDownload'
  | 'cancelModelDownload'
  | 'getModelDownload'
  | 'getModelVerificationProgress'
  | 'cancelModelVerification'
  | 'getModelStorageInfo'
>;

export interface ModelDownloadOptions {
  maxConcurrent?: number;
  pollIntervalMs?: number;
  publishIntervalMs?: number;
}

export const NO_RATE = { bytesPerSecond: null, etaSeconds: null } as const;

export const RESET_PROGRESS = {
  ...NO_RATE,
  bytesWritten: 0,
  verifiedBytes: 0,
  canResume: false,
  verificationPending: false,
  interrupted: false,
  file: null,
} satisfies Partial<ModelDownloadSnapshot>;

export function initialDownloadSnapshot(model: LocalModelDefinition): ModelDownloadSnapshot {
  return {
    ...RESET_PROGRESS,
    modelId: model.id,
    phase: 'loading',
    totalBytes: model.bytes,
    error: null,
  };
}

/** Maps a native transfer that is not running to the model's resting snapshot. */
export function restingPatch(
  model: LocalModelDefinition,
  transfer: NativeModelTransfer,
  verificationBytes: number | null,
  expectedRunning = false,
): Partial<ModelDownloadSnapshot> {
  if (verificationBytes !== null || transfer.state === 'completed') {
    // A transfer that finished while the app was closed is verified once the app is active.
    return {
      ...RESET_PROGRESS,
      phase: 'paused',
      bytesWritten: model.bytes,
      verificationPending: true,
      interrupted: true,
      error: null,
    };
  }
  if (transfer.state === 'paused') {
    return {
      ...RESET_PROGRESS,
      phase: 'paused',
      bytesWritten: Math.min(transfer.bytesWritten, model.bytes),
      canResume: transfer.resumable,
      interrupted: transfer.interrupted,
      error: transfer.error,
    };
  }
  if (transfer.state === 'failed' || expectedRunning) {
    return {
      ...RESET_PROGRESS,
      phase: 'error',
      error: transfer.error ?? 'The model download stopped unexpectedly. Restart it.',
    };
  }
  return { ...RESET_PROGRESS, phase: 'not_downloaded', error: null };
}

export function validateModelFile(
  model: LocalModelDefinition,
  file: LocalModelFile,
): LocalModelFile {
  if (file.id !== model.id || file.sha256 !== model.sha256 || file.bytes !== model.bytes) {
    throw new Error(
      'The installed model does not match the catalog. Remove it and download again.',
    );
  }
  return file;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The model download failed.';
}

const SPEED_SMOOTHING = 0.3;
const MINIMUM_SAMPLE_MS = 200;

/** Smoothed transfer rate and remaining-time estimate from periodic byte counts. */
export class TransferRateEstimator {
  private last: { at: number; bytes: number } | null = null;
  private rate: number | null = null;

  reset(): void {
    this.last = null;
    this.rate = null;
  }

  sample(at: number, bytes: number): void {
    if (!this.last || bytes < this.last.bytes) {
      this.last = { at, bytes };
      return;
    }
    const elapsed = at - this.last.at;
    if (elapsed < MINIMUM_SAMPLE_MS) {
      return;
    }
    const instant = ((bytes - this.last.bytes) * 1000) / elapsed;
    this.rate =
      this.rate === null ? instant : SPEED_SMOOTHING * instant + (1 - SPEED_SMOOTHING) * this.rate;
    this.last = { at, bytes };
  }

  bytesPerSecond(): number | null {
    return this.rate === null ? null : Math.round(this.rate);
  }

  etaSeconds(remaining: number): number | null {
    return this.rate && this.rate > 0 ? Math.ceil(Math.max(remaining, 0) / this.rate) : null;
  }
}
