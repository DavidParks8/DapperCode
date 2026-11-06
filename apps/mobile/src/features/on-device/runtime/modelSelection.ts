import { localModelDefinition } from '../models/catalog';
import type { LocalPreferencesStore } from './preferences';
import type { ModelResidency } from './residency';
import type { OnDeviceRuntime } from './runtime';

export class LocalModelSelection {
  private choices: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly runtime: Pick<OnDeviceRuntime, 'threads' | 'models' | 'loop'>,
    private readonly settings: LocalPreferencesStore,
    private readonly residency: ModelResidency,
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

  private isRunning(threadId: string): boolean {
    const run = this.runtime.loop.snapshot();
    return (
      (run.phase !== 'idle' && run.threadId === threadId) ||
      this.runtime.threads.find(threadId)?.status === 'running'
    );
  }
}
