import type { LocalModelSession } from '../models/session';
import { LocalModelInterrupted } from '../models/session';

/** FIFO cooperative turns on the single resident context, not parallel GPU inference. */
export class LocalInferenceScheduler {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly model: Pick<LocalModelSession, 'generate'>) {}

  generate(
    signal: AbortSignal,
    ...args: Parameters<LocalModelSession['generate']>
  ): ReturnType<LocalModelSession['generate']> {
    const work = this.tail
      .catch(() => undefined)
      .then(() => {
        if (signal.aborted) {
          throw new LocalModelInterrupted();
        }
        return this.model.generate(...args);
      });
    this.tail = work;
    return work;
  }
}
