import { randomUUID } from 'expo-crypto';
import type { OnDeviceNativeServices } from '../native/services.types';
import { quarantineDocument } from './quarantine';
import { parseLocalThread, recoverLocalThread, threadDocument } from './threadCodec';
import type { LocalThread } from './types';

export type LocalDocumentPort = Pick<
  OnDeviceNativeServices,
  'readRuntimeDocument' | 'writeRuntimeDocument' | 'listRuntimeDocuments' | 'removeRuntimeDocument'
>;

/** `content` changes can be coalesced by observers; `persistence` changes affect durable state. */
export type LocalThreadChange = 'content' | 'persistence';

export interface LocalThreadRecovery {
  /** Damaged or unexpected files moved to a quarantine name with their bytes preserved. */
  setAside: number;
  /** Damaged or unreadable files that could not be moved; they were skipped and left in place. */
  leftInPlace: number;
  /** Conversation identities whose files were set aside or skipped. */
  ids: ReadonlySet<string>;
}

interface PersistedThread {
  contents: string;
  journal: ReadonlySet<string>;
  running: boolean;
}

/** Delay for coalescing progress writes that are not needed by the run journal. */
export const THREAD_PROGRESS_SAVE_DELAY_MS = 250;

function journalEntries(thread: LocalThread): Set<string> {
  const entries = new Set<string>();
  for (const message of thread.messages) {
    if (message.role !== 'assistant') {
      entries.add(`message:${message.id}`);
    }
    for (const call of message.toolCalls ?? []) {
      entries.add(`call:${call.id}`);
    }
  }
  return entries;
}

export class LocalThreadRepository {
  private readonly threads = new Map<string, LocalThread>();
  private readonly failures = new Map<string, Error>();
  private readonly persisted = new Map<string, PersistedThread>();
  private readonly queued = new Map<string, Promise<void>>();
  private readonly progress = new Map<string, ReturnType<typeof setTimeout>>();
  private writes: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | null = null;
  private recoveryValue: LocalThreadRecovery = { setAside: 0, leftInPlace: 0, ids: new Set() };

  constructor(
    private readonly storage: LocalDocumentPort,
    private readonly changed: (change: LocalThreadChange) => void,
    private readonly progressDelayMs = THREAD_PROGRESS_SAVE_DELAY_MS,
  ) {}

  initialize(): Promise<void> {
    this.initialized ??= this.restore().catch((error: unknown) => {
      this.initialized = null;
      throw error;
    });
    return this.initialized;
  }

  recovery(): LocalThreadRecovery {
    return this.recoveryValue;
  }

  list(): LocalThread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  find(id: string): LocalThread | null {
    return this.threads.get(id) ?? null;
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

  persistenceFailures(): ReadonlyMap<string, Error> {
    return this.failures;
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
    this.changed('content');
    await this.save(thread.id);
    return thread;
  }

  change(id: string, update: (thread: LocalThread) => LocalThread): LocalThread {
    const next = update(this.get(id));
    if (next.id !== id) {
      throw new Error('A local conversation update cannot change its identity.');
    }
    this.threads.set(id, next);
    this.changed('content');
    return next;
  }

  /**
   * Makes the conversation durable. Journal entries (user turns, tool-call intent, and tool
   * invocations) are written before this resolves. Run progress that recovery can safely
   * reconstruct (streamed text, tool results, settlement) is coalesced into a short-delayed
   * write; `flush()` forces it.
   */
  save(id: string): Promise<void> {
    const thread = this.get(id);
    if (!this.requiresJournalWrite(id, thread)) {
      this.scheduleProgress(id);
      return Promise.resolve();
    }
    return this.write(id);
  }

  async flush(): Promise<void> {
    const pending = [...this.progress.keys()];
    for (const id of pending) {
      this.cancelProgress(id);
    }
    await Promise.allSettled(pending.map((id) => this.write(id)));
    await this.writes;
    const failure = this.persistenceError();
    if (failure) {
      throw failure;
    }
  }

  async retryPersistence(): Promise<void> {
    for (const id of [...this.failures.keys()]) {
      if (this.threads.has(id)) {
        await this.write(id);
      } else {
        this.failures.delete(id);
      }
    }
    this.changed('persistence');
  }

  async remove(id: string): Promise<void> {
    const thread = this.get(id);
    if (thread.status === 'running') {
      throw new Error('Stop the local run before deleting its conversation.');
    }
    this.cancelProgress(id);
    await this.writes;
    await this.storage.removeRuntimeDocument(threadDocument(id));
    this.threads.delete(id);
    this.failures.delete(id);
    this.persisted.delete(id);
    this.changed('persistence');
  }

  close(): void {
    for (const id of [...this.progress.keys()]) {
      this.cancelProgress(id);
    }
  }

  private requiresJournalWrite(id: string, thread: LocalThread): boolean {
    const previous = this.persisted.get(id);
    if (!previous || this.failures.has(id)) {
      return true;
    }
    if (thread.status !== 'running' && !previous.running) {
      return true;
    }
    if (thread.status === 'running' && !previous.running) {
      return true;
    }
    for (const entry of journalEntries(thread)) {
      if (!previous.journal.has(entry)) {
        return true;
      }
    }
    return false;
  }

  private scheduleProgress(id: string): void {
    if (this.progress.has(id)) {
      return;
    }
    this.progress.set(
      id,
      setTimeout(() => {
        this.progress.delete(id);
        void this.write(id).catch(() => undefined);
      }, this.progressDelayMs),
    );
  }

  private cancelProgress(id: string): void {
    const timer = this.progress.get(id);
    if (timer) {
      clearTimeout(timer);
      this.progress.delete(id);
    }
  }

  /** Serializes at write time so queued saves of one conversation collapse into one write. */
  private write(id: string): Promise<void> {
    this.cancelProgress(id);
    const queued = this.queued.get(id);
    if (queued) {
      return queued;
    }
    const write = this.writes.then(async () => {
      this.queued.delete(id);
      const thread = this.threads.get(id);
      if (!thread) {
        return;
      }
      const contents = JSON.stringify(thread);
      if (this.persisted.get(id)?.contents !== contents) {
        await this.storage.writeRuntimeDocument(threadDocument(id), contents);
        this.persisted.set(id, {
          contents,
          journal: journalEntries(thread),
          running: thread.status === 'running',
        });
      }
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    const settled = write.then(
      () => {
        if (this.failures.delete(id)) {
          this.changed('persistence');
        }
      },
      (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error('Local conversation persistence failed.');
        this.failures.set(id, failure);
        this.changed('persistence');
        throw failure;
      },
    );
    this.queued.set(id, settled);
    return settled;
  }

  private async restore(): Promise<void> {
    const documents = await this.storage.listRuntimeDocuments('thread-');
    const loaded = new Map<string, LocalThread>();
    const recovered: string[] = [];
    const affected = new Set<string>();
    let setAside = 0;
    let leftInPlace = 0;
    const quarantine = async (name: string, raw: string | null, id: string | undefined) => {
      if (id) {
        affected.add(id);
      }
      if (await quarantineDocument(this.storage, name, raw)) {
        setAside += 1;
      } else {
        leftInPlace += 1;
      }
    };
    for (const name of documents) {
      const id = /^thread-([a-f0-9-]+)\.json$/u.exec(name)?.[1];
      let valid = false;
      try {
        valid = Boolean(id && threadDocument(id) === name);
      } catch {
        valid = false;
      }
      if (!id || !valid) {
        await quarantine(name, null, undefined);
        continue;
      }
      let raw: string | null;
      try {
        raw = await this.storage.readRuntimeDocument(name);
      } catch {
        affected.add(id);
        leftInPlace += 1;
        continue;
      }
      if (raw === null) {
        continue;
      }
      let original: LocalThread;
      try {
        original = parseLocalThread(raw, id);
      } catch {
        await quarantine(name, raw, id);
        continue;
      }
      const thread = recoverLocalThread(original);
      this.persisted.set(id, {
        contents: raw,
        journal: journalEntries(original),
        running: original.status === 'running',
      });
      if (thread !== original) {
        recovered.push(id);
      }
      loaded.set(id, thread);
    }
    this.threads.clear();
    for (const [id, thread] of loaded) {
      this.threads.set(id, thread);
    }
    this.recoveryValue = { setAside, leftInPlace, ids: affected };
    await Promise.allSettled(recovered.map((id) => this.write(id)));
    this.changed('persistence');
  }
}
