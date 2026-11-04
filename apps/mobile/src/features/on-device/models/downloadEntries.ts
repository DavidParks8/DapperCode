import { initialDownloadSnapshot, TransferRateEstimator } from './downloadState';
import type { ModelDownloadSnapshot } from './downloadState';
import type { LocalModelDefinition } from './types';

export type DownloadJob =
  'preparing' | 'queued' | 'starting' | 'transferring' | 'pausing' | 'cancelling' | 'verifying';

export interface DownloadEntry {
  model: LocalModelDefinition;
  value: ModelDownloadSnapshot;
  job: DownloadJob | null;
  pending: Promise<unknown> | null;
  request: 'pause' | 'cancel' | null;
  rate: TransferRateEstimator;
  publishedAt: number;
  waiters: (() => void)[];
}

const RESERVING_JOBS: readonly DownloadJob[] = ['queued', 'starting', 'transferring', 'pausing'];
const NETWORK_JOBS: readonly DownloadJob[] = ['starting', 'transferring', 'pausing'];

/** Per-model download state, throttled publication, and the FIFO queue of waiting transfers. */
export class DownloadEntries {
  private readonly entries = new Map<string, DownloadEntry>();
  private readonly queue: string[] = [];

  constructor(
    catalog: readonly LocalModelDefinition[],
    private readonly changed: (snapshot: ModelDownloadSnapshot) => void,
    private readonly publishIntervalMs: number,
  ) {
    for (const model of catalog) {
      this.entries.set(model.id, {
        model,
        value: initialDownloadSnapshot(model),
        job: null,
        pending: null,
        request: null,
        rate: new TransferRateEstimator(),
        publishedAt: Number.NEGATIVE_INFINITY,
        waiters: [],
      });
    }
  }

  get(id: string): DownloadEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error('This model is not in the on-device catalog.');
    }
    return entry;
  }

  find(id: string): DownloadEntry | undefined {
    return this.entries.get(id);
  }

  values(): DownloadEntry[] {
    return [...this.entries.values()];
  }

  /** Entries with no queued, running, or verifying work. */
  idle(): DownloadEntry[] {
    return this.values().filter((entry) => !entry.job);
  }

  enqueue(entry: DownloadEntry): void {
    entry.job = 'queued';
    this.queue.push(entry.model.id);
  }

  dequeue(entry: DownloadEntry): void {
    const index = this.queue.indexOf(entry.model.id);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  /** The next queued entry, if a network slot is free. */
  next(maxConcurrent: number): DownloadEntry | undefined {
    while (this.queue.length && this.networkJobs() < maxConcurrent) {
      const entry = this.entries.get(this.queue.shift() ?? '');
      if (entry?.job === 'queued') {
        return entry;
      }
    }
    return undefined;
  }

  networkJobs(): number {
    return this.values().filter((entry) => entry.job !== null && NETWORK_JOBS.includes(entry.job))
      .length;
  }

  /** Bytes that queued and running transfers still need on disk. */
  reservedBytes(): number {
    return this.values()
      .filter((entry) => entry.job !== null && RESERVING_JOBS.includes(entry.job))
      .reduce(
        (total, entry) => total + Math.max(entry.model.bytes - entry.value.bytesWritten, 0),
        0,
      );
  }

  async settled(entry: DownloadEntry): Promise<ModelDownloadSnapshot> {
    while (entry.job) {
      await new Promise<void>((resolve) => entry.waiters.push(resolve));
    }
    return entry.value;
  }

  publish(entry: DownloadEntry, patch: Partial<ModelDownloadSnapshot>): ModelDownloadSnapshot {
    entry.value = { ...entry.value, ...patch };
    entry.publishedAt = Date.now();
    this.changed(entry.value);
    if (!entry.job) {
      for (const waiter of entry.waiters.splice(0)) {
        waiter();
      }
    }
    return entry.value;
  }

  /** Progress-only updates are coalesced so each model publishes at most a few times a second. */
  publishProgress(entry: DownloadEntry, now: number, patch: Partial<ModelDownloadSnapshot>): void {
    entry.value = { ...entry.value, ...patch };
    if (now - entry.publishedAt >= this.publishIntervalMs) {
      entry.publishedAt = now;
      this.changed(entry.value);
    }
  }
}
