import { localModelDefinition } from '../models/catalog';
import type { ModelDownloadController } from '../models/downloads';
import { modelMemoryAdmission } from '../models/memory';
import type { LocalModelSession } from '../models/session';
import type { DeviceMemory } from '../models/types';

export interface ModelResidencyPorts {
  models: Pick<LocalModelSession, 'snapshot' | 'load' | 'unload'>;
  downloads: Pick<ModelDownloadController, 'snapshot'>;
  /** True when no conversation run is active. */
  idle: () => boolean;
  memory: () => DeviceMemory;
}

/**
 * Serializes model loads/unloads and restores the model that backgrounding unloaded. Turns are
 * never replayed; downloads continue in the background and are not tracked here.
 */
export class ModelResidency {
  private model: string | null = null;
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

  /** Records the loaded model before backgrounding unloads it. */
  rememberForBackground(): void {
    const model = this.ports.models.snapshot();
    if (model.modelId && model.phase !== 'empty' && model.phase !== 'error') {
      this.model = model.modelId;
    }
  }

  /** Forgets the warm-up for one model, or for any model when `id` is omitted. */
  forget(id?: string): void {
    if (id === undefined || this.model === id) {
      this.model = null;
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
