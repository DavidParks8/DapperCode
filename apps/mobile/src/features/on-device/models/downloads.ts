import { requireLocalModelRuntime } from './catalog';
import {
  errorMessage as message,
  NO_RATE,
  RESET_PROGRESS,
  restingPatch,
  validateModelFile,
} from './downloadState';
import type {
  ModelDownloadOptions,
  ModelDownloadPhase,
  ModelDownloadSnapshot,
  ModelFilePort,
  ModelStorageSnapshot,
  NativeModelStorageInfo,
  NativeModelTransfer,
} from './downloadState';
import { DownloadEntries } from './downloadEntries';
import { settlePauseFailure, settleVerification } from './downloadOutcomes';
import type { DownloadEntry } from './downloadEntries';
import type { LocalModelDefinition, LocalModelFile } from './types';

export type {
  ModelDownloadOptions,
  ModelDownloadPhase,
  ModelDownloadSnapshot,
  ModelFilePort,
  ModelStorageSnapshot,
} from './downloadState';

export const MAX_CONCURRENT_MODEL_DOWNLOADS = 2;
const DISK_RESERVE_BYTES = 64 * 1024 * 1024;
const SETTLED_PHASES: readonly ModelDownloadPhase[] = ['ready', 'not_downloaded', 'loading'];

/**
 * Schedules model transfers in a native background URL session. Actions resolve once work is
 * accepted (started or queued); progress and failures are reported per model through snapshots.
 */
export class ModelDownloadController {
  private readonly entries: DownloadEntries;
  private readonly maxConcurrent: number;
  private readonly pollIntervalMs: number;
  private attachment: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private storageValue: NativeModelStorageInfo | null = null;
  private disposed = false;

  constructor(
    catalog: readonly LocalModelDefinition[],
    private readonly native: ModelFilePort,
    private readonly changed: (snapshot: ModelDownloadSnapshot | null) => void,
    options: ModelDownloadOptions = {},
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? MAX_CONCURRENT_MODEL_DOWNLOADS);
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.entries = new DownloadEntries(catalog, changed, options.publishIntervalMs ?? 250);
  }

  snapshot(id: string): ModelDownloadSnapshot {
    return this.entries.get(id).value;
  }

  /** Disk usage for model files plus free space, or null before the first refresh. */
  storage(): ModelStorageSnapshot | null {
    const info = this.storageValue;
    return info && { ...info, reservedBytes: this.entries.reservedBytes() };
  }

  async refreshStorage(): Promise<ModelStorageSnapshot> {
    this.storageValue = await this.native.getModelStorageInfo();
    this.changed(null);
    return { ...this.storageValue, reservedBytes: this.entries.reservedBytes() };
  }

  /** Resolves when the model has no queued, running, or verifying work. */
  settled(id: string): Promise<ModelDownloadSnapshot> {
    return this.entries.settled(this.entries.get(id));
  }

  async inspect(id: string): Promise<ModelDownloadSnapshot> {
    const entry = this.entries.get(id);
    if (entry.job) {
      return entry.value;
    }
    try {
      await this.attach();
      if (entry.job) {
        return entry.value;
      }
      const file = await this.checkedFile(entry.model);
      if (file) {
        return this.ready(entry, file);
      }
      const paths = await this.native.getModelFilePaths(id);
      return this.rest(entry, this.native.getModelDownload(id), paths.verificationBytes);
    } catch (error) {
      if (!entry.job) {
        this.entries.publish(entry, { phase: 'error', error: message(error) });
      }
      throw error;
    }
  }

  download(id: string): Promise<ModelDownloadSnapshot> {
    return this.begin(id, 'download');
  }

  resume(id: string): Promise<ModelDownloadSnapshot> {
    return this.begin(id, 'resume');
  }

  /** Verifies a completed transfer; resolves once verification has started. */
  verify(id: string): Promise<ModelDownloadSnapshot> {
    return this.begin(id, 'verify');
  }

  /** Pauses a queued, running, or verifying model. Failures are recorded on its snapshot. */
  pause(id: string): Promise<ModelDownloadSnapshot> {
    return this.stop(this.entries.get(id), 'pause');
  }

  /**
   * Stops queued, running, or verifying work and discards partial data. An installed model is
   * never deleted by cancel; use `remove()`. Failures are recorded on the model's snapshot.
   */
  cancel(id: string): Promise<ModelDownloadSnapshot> {
    return this.stop(this.entries.get(id), 'cancel');
  }

  /** Stops any work for the model and deletes all of its files, including an installed model. */
  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    while (entry.job && entry.job !== 'queued' && entry.job !== 'transferring') {
      await this.stop(entry, 'cancel');
    }
    const result = await this.discard(entry);
    if (result.error) {
      throw new Error(result.error);
    }
  }

  /** Pauses all queued, running, and verifying work (for example under storage pressure). */
  async pauseAll(): Promise<void> {
    await Promise.all(this.entries.values().map((entry) => this.stop(entry, 'pause')));
  }

  /** Resumes every resting transfer that can continue, including ones the user paused. */
  async resumeAll(): Promise<void> {
    await this.continueResting(() => true);
  }

  /**
   * Call when the app becomes active: re-attaches background transfers, then continues work the
   * system interrupted (force quit, network loss, or a relaunch before verification finished).
   */
  async resumeLifecyclePaused(): Promise<void> {
    await this.refresh();
    await this.continueResting((entry) => entry.value.interrupted);
  }

  /** Stops progress polling. Native background transfers keep running and are re-attached later. */
  dispose(): void {
    this.disposed = true;
    this.stopPolling();
  }

  private async refresh(): Promise<void> {
    this.attachment = null;
    await Promise.allSettled(this.entries.idle().map((entry) => this.inspect(entry.model.id)));
  }

  private async continueResting(include: (entry: DownloadEntry) => boolean): Promise<void> {
    await Promise.allSettled(
      this.entries
        .idle()
        .filter(
          (entry) => (entry.value.canResume || entry.value.verificationPending) && include(entry),
        )
        .map((entry) =>
          entry.value.verificationPending
            ? this.verify(entry.model.id)
            : this.resume(entry.model.id),
        ),
    );
  }

  private async stop(
    entry: DownloadEntry,
    kind: 'pause' | 'cancel',
  ): Promise<ModelDownloadSnapshot> {
    switch (entry.job) {
      case null:
        return kind === 'cancel' && !SETTLED_PHASES.includes(entry.value.phase)
          ? this.discard(entry)
          : entry.value;
      case 'verifying':
      case 'preparing':
        return this.interrupt(entry, kind);
      case 'starting':
      case 'pausing':
      case 'cancelling':
        await entry.pending;
        return this.stop(entry, kind);
      case 'queued':
      case 'transferring':
        return kind === 'cancel' ? this.discard(entry) : this.pauseScheduled(entry);
    }
  }

  /** Asks preflight or verification to stop at its next checkpoint, then settles the request. */
  private async interrupt(
    entry: DownloadEntry,
    kind: 'pause' | 'cancel',
  ): Promise<ModelDownloadSnapshot> {
    entry.request = kind;
    if (entry.job === 'verifying') {
      this.native.cancelModelVerification(entry.model.id);
    }
    await entry.pending;
    entry.request = null;
    return entry.job ? this.stop(entry, kind) : entry.value;
  }

  private async begin(
    id: string,
    mode: 'download' | 'resume' | 'verify',
  ): Promise<ModelDownloadSnapshot> {
    const entry = this.entries.get(id);
    if (entry.job) {
      return entry.value;
    }
    entry.job = 'preparing';
    entry.request = null;
    this.entries.publish(entry, { phase: 'preparing', error: null });
    const preflight = this.prepare(entry, mode);
    entry.pending = preflight.catch(() => undefined);
    try {
      return await preflight;
    } catch (error) {
      if (entry.job === 'preparing' || entry.job === 'starting') {
        entry.job = null;
      }
      this.entries.publish(entry, { phase: 'error', error: message(error) });
      this.drain();
      throw error;
    }
  }

  private async prepare(
    entry: DownloadEntry,
    mode: 'download' | 'resume' | 'verify',
  ): Promise<ModelDownloadSnapshot> {
    const { model } = entry;
    requireLocalModelRuntime(model);
    await this.attach();
    if (entry.job !== 'preparing') {
      return entry.value;
    }
    const file = await this.checkedFile(model);
    if (file) {
      entry.job = null;
      return this.ready(entry, file);
    }
    const paths = await this.native.getModelFilePaths(model.id);
    const transfer = this.native.getModelDownload(model.id);
    if (mode === 'verify') {
      return this.prepareVerification(entry, paths.verificationBytes, transfer);
    }
    if (transfer.state === 'running') {
      return this.adopt(entry, transfer);
    }
    if (paths.verificationBytes !== null || transfer.state === 'completed') {
      throw new Error('Verify the pending model file or remove it before restarting its download.');
    }
    const resumable = transfer.state === 'paused' && transfer.resumable;
    if (mode === 'resume' && !resumable) {
      throw new Error('No resumable transfer is available. Restart this model download.');
    }
    return this.schedule(entry, resumable ? transfer : null, paths.availableBytes);
  }

  private async prepareVerification(
    entry: DownloadEntry,
    verificationBytes: number | null,
    transfer: NativeModelTransfer,
  ): Promise<ModelDownloadSnapshot> {
    if (verificationBytes === null && transfer.state !== 'completed') {
      throw new Error('No completed download is waiting for verification.');
    }
    if (!(await this.consumeRequest(entry))) {
      this.startVerification(entry);
    }
    return entry.value;
  }

  /** Reserves disk space, then starts the transfer or queues it behind running ones. */
  private async schedule(
    entry: DownloadEntry,
    checkpoint: NativeModelTransfer | null,
    availableBytes: number,
  ): Promise<ModelDownloadSnapshot> {
    const { model } = entry;
    const written = Math.min(Math.max(checkpoint?.bytesWritten ?? 0, 0), model.bytes);
    if (
      availableBytes - this.entries.reservedBytes() <
      model.bytes - written + DISK_RESERVE_BYTES
    ) {
      throw new Error('Not enough free storage for this model download.');
    }
    if (await this.consumeRequest(entry)) {
      return entry.value;
    }
    entry.value = { ...entry.value, bytesWritten: written, canResume: checkpoint !== null };
    if (this.entries.networkJobs() >= this.maxConcurrent) {
      this.entries.enqueue(entry);
      return this.entries.publish(entry, {
        phase: 'queued',
        ...NO_RATE,
        interrupted: false,
        error: null,
      });
    }
    return this.startTransfer(entry);
  }

  /** Applies a pause/cancel requested while preflight was in progress. */
  private async consumeRequest(entry: DownloadEntry): Promise<boolean> {
    const request = entry.request;
    entry.request = null;
    if (request === 'pause') {
      entry.job = null;
      await this.inspect(entry.model.id).catch(() => undefined);
      return true;
    }
    if (request === 'cancel') {
      await this.discard(entry);
      return true;
    }
    return false;
  }

  private async startTransfer(entry: DownloadEntry): Promise<ModelDownloadSnapshot> {
    const { model } = entry;
    entry.job = 'starting';
    const transfer = await this.native.startModelDownload(model.id, model.downloadUrl, model.bytes);
    return this.adopt(entry, transfer);
  }

  private adopt(entry: DownloadEntry, transfer: NativeModelTransfer): ModelDownloadSnapshot {
    entry.job = 'transferring';
    entry.rate.reset();
    entry.rate.sample(Date.now(), transfer.bytesWritten);
    this.ensurePolling();
    return this.entries.publish(entry, {
      phase: 'downloading',
      bytesWritten: transfer.bytesWritten,
      ...NO_RATE,
      canResume: false,
      verificationPending: false,
      interrupted: false,
      error: null,
    });
  }

  private drain(): void {
    for (
      let entry = this.disposed ? undefined : this.entries.next(this.maxConcurrent);
      entry;
      entry = this.entries.next(this.maxConcurrent)
    ) {
      const start = this.startTransfer(entry).catch((error: unknown) => {
        entry.job = null;
        this.entries.publish(entry, { phase: 'error', error: message(error) });
        this.drain();
      });
      entry.pending = start;
    }
  }

  private async pauseScheduled(entry: DownloadEntry): Promise<ModelDownloadSnapshot> {
    if (entry.job === 'queued') {
      this.entries.dequeue(entry);
      entry.job = null;
      return this.entries.publish(entry, {
        phase: entry.value.canResume ? 'paused' : 'not_downloaded',
        interrupted: false,
        error: null,
      });
    }
    entry.job = 'pausing';
    const run = (async () => {
      try {
        const transfer = await this.native.pauseModelDownload(entry.model.id);
        entry.job = null;
        if (transfer.state === 'completed') {
          this.startVerification(entry);
        } else if (transfer.state === 'paused') {
          this.entries.publish(entry, restingPatch(entry.model, transfer, null));
        } else {
          this.entries.publish(entry, {
            ...RESET_PROGRESS,
            phase: 'not_downloaded',
            error: 'This server could not save the transfer for resuming. Download it again.',
          });
        }
      } catch (error) {
        settlePauseFailure(entry, this.native, this.entries, error);
      } finally {
        this.drain();
      }
    })();
    entry.pending = run;
    await run;
    return entry.value;
  }

  private async discard(entry: DownloadEntry, failure?: string): Promise<ModelDownloadSnapshot> {
    this.entries.dequeue(entry);
    entry.job = 'cancelling';
    const run = (async () => {
      try {
        await this.native.removeModelFile(entry.model.id);
        entry.job = null;
        this.entries.publish(entry, {
          ...RESET_PROGRESS,
          phase: failure ? 'error' : 'not_downloaded',
          error: failure ?? null,
        });
        void this.refreshStorage().catch(() => undefined);
      } catch (error) {
        entry.job = null;
        this.entries.publish(entry, {
          phase: 'error',
          ...NO_RATE,
          error: message(error),
        });
      } finally {
        this.drain();
      }
    })();
    entry.pending = run;
    await run;
    return entry.value;
  }

  private startVerification(entry: DownloadEntry): void {
    const { model } = entry;
    entry.job = 'verifying';
    entry.request = null;
    entry.rate.reset();
    this.ensurePolling();
    this.entries.publish(entry, {
      phase: 'verifying',
      bytesWritten: model.bytes,
      verifiedBytes: 0,
      ...NO_RATE,
      canResume: false,
      verificationPending: true,
      interrupted: false,
      error: null,
    });
    entry.pending = settleVerification(entry, this.native, this.entries).then((outcome) => {
      if (outcome === 'cancel') {
        return this.discard(entry);
      }
      if (outcome === 'ready') {
        void this.refreshStorage().catch(() => undefined);
      }
      return undefined;
    });
  }

  private ensurePolling(): void {
    if (!this.timer && !this.disposed) {
      this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    }
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    let active = false;
    for (const entry of this.entries.values()) {
      if (entry.job === 'transferring') {
        active = true;
        this.observeTransfer(entry);
      } else if (entry.job === 'verifying') {
        active = true;
        this.observeVerification(entry);
      } else if (entry.job) {
        active = true;
      }
    }
    if (!active) {
      this.stopPolling();
    }
  }

  private observeTransfer(entry: DownloadEntry): void {
    const { model } = entry;
    let transfer: NativeModelTransfer;
    try {
      transfer = this.native.getModelDownload(model.id);
    } catch (error) {
      entry.job = null;
      this.entries.publish(entry, { phase: 'error', error: message(error) });
      this.drain();
      return;
    }
    if (transfer.state === 'running') {
      if (
        !Number.isSafeInteger(transfer.bytesWritten) ||
        transfer.bytesWritten < 0 ||
        transfer.bytesWritten > model.bytes
      ) {
        void this.discard(entry, 'The model transfer size does not match the catalog.');
        return;
      }
      const now = Date.now();
      entry.rate.sample(now, transfer.bytesWritten);
      this.entries.publishProgress(entry, now, {
        bytesWritten: transfer.bytesWritten,
        bytesPerSecond: entry.rate.bytesPerSecond(),
        etaSeconds: entry.rate.etaSeconds(model.bytes - transfer.bytesWritten),
      });
      return;
    }
    entry.job = null;
    if (transfer.state === 'completed') {
      this.startVerification(entry);
    } else {
      this.entries.publish(entry, restingPatch(model, transfer, null, true));
    }
    this.drain();
  }

  private observeVerification(entry: DownloadEntry): void {
    const progress = this.native.getModelVerificationProgress(entry.model.id);
    if (!progress.active) {
      return;
    }
    const now = Date.now();
    entry.rate.sample(now, progress.completed);
    this.entries.publishProgress(entry, now, {
      verifiedBytes: progress.completed,
      bytesPerSecond: entry.rate.bytesPerSecond(),
      etaSeconds: entry.rate.etaSeconds(progress.total - progress.completed),
    });
  }

  private rest(
    entry: DownloadEntry,
    transfer: NativeModelTransfer,
    verificationBytes: number | null,
  ): ModelDownloadSnapshot {
    return transfer.state === 'running'
      ? this.adopt(entry, transfer)
      : this.entries.publish(entry, restingPatch(entry.model, transfer, verificationBytes));
  }

  private ready(entry: DownloadEntry, file: LocalModelFile): ModelDownloadSnapshot {
    return this.entries.publish(entry, {
      ...RESET_PROGRESS,
      phase: 'ready',
      file,
      bytesWritten: entry.model.bytes,
      error: null,
    });
  }

  private attach(): Promise<void> {
    this.attachment ??= this.native.attachModelDownloads().then(
      (transfers) => {
        for (const transfer of transfers) {
          const entry = this.entries.find(transfer.id);
          if (entry && (!entry.job || entry.job === 'preparing') && transfer.state === 'running') {
            this.adopt(entry, transfer);
          }
        }
      },
      (error: unknown) => {
        this.attachment = null;
        throw error;
      },
    );
    return this.attachment;
  }

  private async checkedFile(model: LocalModelDefinition): Promise<LocalModelFile | null> {
    const file = await this.native.getDownloadedModelFile(model.id);
    return file ? validateModelFile(model, file) : null;
  }
}
