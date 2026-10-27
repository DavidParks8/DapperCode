import { randomUUID } from 'expo-crypto';
import type { OnDeviceNativeServices } from '../native/services.types';
import { parseLocalThread, recoverLocalThread, threadDocument } from './threadCodec';
import type { LocalThread } from './types';

export type LocalDocumentPort = Pick<
  OnDeviceNativeServices,
  'readRuntimeDocument' | 'writeRuntimeDocument' | 'listRuntimeDocuments' | 'removeRuntimeDocument'
>;

export class LocalThreadRepository {
  private readonly threads = new Map<string, LocalThread>();
  private readonly failures = new Map<string, Error>();
  private writes: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | null = null;

  constructor(
    private readonly storage: LocalDocumentPort,
    private readonly changed: () => void,
  ) {}

  initialize(): Promise<void> {
    this.initialized ??= this.restore().catch((error: unknown) => {
      this.initialized = null;
      throw error;
    });
    return this.initialized;
  }

  list(): LocalThread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): LocalThread {
    const thread = this.threads.get(id);
    if (!thread) {
      throw new Error('This local conversation is unavailable.');
    }
    return thread;
  }

  persistenceError(): Error | null {
    return this.failures.values().next().value ?? null;
  }

  async create(workspaceId: string, modelId: string): Promise<LocalThread> {
    const now = new Date().toISOString();
    const thread: LocalThread = {
      version: 1,
      id: randomUUID().toLowerCase(),
      title: 'New local conversation',
      workspaceId,
      modelId,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      activeTurnId: null,
      lastSubmissionId: null,
      lastError: null,
      messages: [],
    };
    this.threads.set(thread.id, thread);
    this.changed();
    await this.save(thread.id);
    return thread;
  }

  change(id: string, update: (thread: LocalThread) => LocalThread): LocalThread {
    const next = update(this.get(id));
    if (next.id !== id) {
      throw new Error('A local conversation update cannot change its identity.');
    }
    this.threads.set(id, next);
    this.changed();
    return next;
  }

  save(id: string): Promise<void> {
    const name = threadDocument(id);
    const contents = JSON.stringify(this.get(id));
    const write = this.writes.then(() => this.storage.writeRuntimeDocument(name, contents));
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(
      () => {
        this.failures.delete(id);
        this.changed();
      },
      (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error('Local conversation persistence failed.');
        this.failures.set(id, failure);
        this.changed();
        throw failure;
      },
    );
  }

  async flush(): Promise<void> {
    await this.writes;
    const failure = this.persistenceError();
    if (failure) {
      throw failure;
    }
  }

  async retryPersistence(): Promise<void> {
    for (const id of [...this.failures.keys()]) {
      await this.save(id);
    }
  }

  async remove(id: string): Promise<void> {
    const thread = this.get(id);
    if (thread.status === 'running') {
      throw new Error('Stop the local run before deleting its conversation.');
    }
    await this.writes;
    await this.storage.removeRuntimeDocument(threadDocument(id));
    this.threads.delete(id);
    this.failures.delete(id);
    this.changed();
  }

  private async restore(): Promise<void> {
    const documents = await this.storage.listRuntimeDocuments('thread-');
    const loaded = new Map<string, LocalThread>();
    for (const name of documents) {
      const match = /^thread-([a-f0-9-]+)\.json$/u.exec(name);
      const id = match?.[1];
      if (!id || threadDocument(id) !== name) {
        throw new Error('An unexpected local conversation file was found. It has been preserved.');
      }
      const raw = await this.storage.readRuntimeDocument(name);
      if (raw === null) {
        throw new Error(
          'A local conversation disappeared while loading. Retry without resetting storage.',
        );
      }
      const original = parseLocalThread(raw, id);
      const thread = recoverLocalThread(original);
      if (thread !== original) {
        await this.storage.writeRuntimeDocument(name, JSON.stringify(thread));
      }
      loaded.set(id, thread);
    }
    this.threads.clear();
    for (const [id, thread] of loaded) {
      this.threads.set(id, thread);
    }
    this.changed();
  }
}
