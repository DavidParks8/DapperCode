import { LOCAL_MODEL_CATALOG, localModelDefinition } from '../models/catalog';
import type { ModelDownloadController, ModelDownloadSnapshot } from '../models/downloads';
import { modelMemoryAdmission } from '../models/memory';
import type { LocalModelSession } from '../models/session';
import type { DeviceMemory } from '../models/types';

const TRANSFERRING: readonly ModelDownloadSnapshot['phase'][] = ['preparing', 'downloading'];

export interface ModelResidencyPorts {
  models: Pick<LocalModelSession, 'snapshot' | 'load' | 'unload'>;
  downloads: Pick<ModelDownloadController, 'snapshot' | 'resume'>;
  /** True when no conversation run is active. */
  idle: () => boolean;
  memory: () => DeviceMemory;
  report: (error: unknown) => void;
}

/**
 * Serializes model loads/unloads and restores what backgrounding paused: the download that was
 * transferring and the model that was loaded. Turns are never replayed.
 */
export class ModelResidency {
  private model: string | null = null;
  private download: string | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly ports: ModelResidencyPorts) {}

  /** Settles when the current load/unload finishes; never rejects. */
  settled(): Promise<void> | null {
    return this.pending;
  }

  transition(action: () => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(action);
    const tracked: Promise<void> = task
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (this.pending === tracked) {
          this.pending = null;
        }
      });
    this.pending = tracked;
    return task;
  }

  /** Records the loaded model and active transfer before backgrounding pauses them. */
  rememberForBackground(): void {
    const model = this.ports.models.snapshot();
    if (model.modelId && model.phase !== 'empty' && model.phase !== 'error') {
      this.model = model.modelId;
    }
    this.download =
      LOCAL_MODEL_CATALOG.find((entry) =>
        TRANSFERRING.includes(this.ports.downloads.snapshot(entry.id).phase),
      )?.id ?? this.download;
  }

  /** Forgets resume intent for one model, or the model warm-up when `id` is omitted. */
  forget(id?: string): void {
    if (id === undefined || this.model === id) {
      this.model = null;
    }
    if (id !== undefined && this.download === id) {
      this.download = null;
    }
  }

  /** Resumes the download paused by backgrounding; only if it is still paused and resumable. */
  resumeDownload(): void {
    const id = this.download;
    if (!id) {
      return;
    }
    this.download = null;
    const snapshot = this.ports.downloads.snapshot(id);
    if (snapshot.phase === 'paused' && snapshot.canResume) {
      void this.ports.downloads.resume(id).catch((error: unknown) => this.ports.report(error));
    }
  }

  /** Reloads the model unloaded by backgrounding when nothing else owns the session. */
  async warm(): Promise<void> {
    const id = this.model;
    this.model = null;
    if (
      !id ||
      this.pending ||
      !this.ports.idle() ||
      this.ports.models.snapshot().phase !== 'empty' ||
      this.ports.downloads.snapshot(id).phase !== 'ready' ||
      modelMemoryAdmission(localModelDefinition(id), this.ports.memory()).status !== 'ready'
    ) {
      return;
    }
    // A failed warm-up leaves the model session's own error state; it is not a runtime issue.
    await this.transition(() => this.ports.models.load(id)).catch(() => undefined);
  }
}
