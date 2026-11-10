import { localModelDefinition } from '../models/catalog';
import type { LocalPreferencesStore } from './preferences';
import type { ModelResidency } from './residency';
import type { OnDeviceRuntime } from './runtime';

export class LocalModelSelection {
  private choices: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly removing = new Set<string>();

  constructor(
    private readonly runtime: Pick<OnDeviceRuntime, 'threads' | 'models' | 'loop' | 'downloads'>,
    private readonly settings: LocalPreferencesStore,
    private readonly residency: ModelResidency,
    /** The loaded model or the downloads changed. */
    private readonly changed: () => void,
  ) {}

  settled(): Promise<void> {
    return this.choices;
  }

  requireSettled(): void {
    if (this.pending > 0) {
      throw new Error(
        'Wait for the model selection to finish saving before sending or changing this conversation.',
      );
    }
  }

  async select(id: string, threadId?: string): Promise<void> {
    localModelDefinition(id);
    if (threadId && this.isRunning(threadId)) {
      throw new Error('Stop this conversation before changing its model.');
    }
    await this.residency.settled();
    const loaded = this.runtime.models.snapshot();
    if (loaded.modelId !== id || (loaded.phase !== 'ready' && loaded.phase !== 'running')) {
      if (this.runtime.loop.snapshot().phase !== 'idle') {
        throw new Error(
          'A local conversation is running. Stop it or wait for it to finish before loading another model.',
        );
      }
      await this.residency.transition(() => this.runtime.models.load(id));
    }
    await this.choose(id, threadId);
  }

  async choose(id: string, threadId?: string): Promise<void> {
    localModelDefinition(id);
    this.pending += 1;
    const choice = this.choices.then(async () => {
      if (threadId && this.isRunning(threadId)) {
        throw new Error('Stop this conversation before changing its model.');
      }
      const { threads } = this.runtime;
      const previous = threadId ? threads.get(threadId).modelId : null;
      try {
        if (threadId) {
          threads.change(threadId, (thread) => ({ ...thread, modelId: id }));
          await threads.save(threadId);
        }
        await this.settings.chooseModel(id);
      } catch (error) {
        if (threadId && previous !== null) {
          threads.change(threadId, (thread) => ({ ...thread, modelId: previous }));
          try {
            await threads.save(threadId);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              'Model selection failed and the previous model could not be saved. Retry saving local data before sending.',
            );
          }
        }
        throw error;
      }
    });
    const settled = choice.finally(() => {
      this.pending -= 1;
    });
    this.choices = settled.then(
      () => undefined,
      () => undefined,
    );
    await settled;
  }

  /** True while `id`'s weights are being deleted, so nothing loads a file being removed. */
  isRemoving(id: string | null | undefined): boolean {
    return id !== null && id !== undefined && this.removing.has(id);
  }

  /** Deletes a download. Unrelated downloads never interrupt a running conversation. */
  async remove(id: string): Promise<void> {
    localModelDefinition(id);
    this.requireSettled();
    const { downloads, loop, models, threads } = this.runtime;
    const run = loop.snapshot();
    const loaded = models.snapshot().modelId === id;
    const used = run.threadId ? threads.find(run.threadId)?.modelId === id : false;
    if (run.phase !== 'idle' && (loaded || used)) {
      throw new Error('Stop the running local conversation before deleting the model it uses.');
    }
    this.residency.forget(id);
    this.removing.add(id);
    this.changed();
    try {
      if (loaded) {
        await this.residency.transition(() => models.unload());
      }
      await downloads.remove(id);
    } finally {
      this.removing.delete(id);
      this.changed();
    }
    if (this.settings.get().modelId === id) {
      this.settings.update({ modelId: null });
      await this.settings.save();
    }
  }

  private isRunning(threadId: string): boolean {
    const run = this.runtime.loop.snapshot();
    return (
      (run.phase !== 'idle' && run.threadId === threadId) ||
      this.runtime.threads.find(threadId)?.status === 'running'
    );
  }
}
