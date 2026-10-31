import { randomUUID } from 'expo-crypto';
import type { OnDeviceNativeServices } from '../native/services.types';
import { quarantineDocument } from './quarantine';
import { parseLocalThreadBase, recoverLocalThread, threadDocument } from './threadCodec';
import {
  applyLocalThreadDelta,
  durableLocalThread,
  encodeLocalThreadBase,
  encodeLocalThreadSegment,
  localThreadDelta,
  parseLocalThreadSegment,
  parseThreadSegmentName,
  THREAD_COMPACT_MIN_BYTES,
  THREAD_COMPACT_SEGMENTS,
  THREAD_SEGMENT_MAX_BYTES,
  THREAD_SEGMENT_PREFIX,
  threadSegmentDocument,
  threadSegmentPrefix,
  utf8Bytes,
  type DurableLocalThread,
  type LocalThreadDelta,
} from './threadJournal';
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
  durable: DurableLocalThread;
  journal: ReadonlySet<string>;
  running: boolean;
  /** The last journal position that is durable, in the base or a segment. */
  sequence: number;
  baseBytes: number;
  /** Segments written since the base, removed once a new base contains them. */
  segments: readonly number[];
  segmentBytes: number;
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

type SegmentName = { name: string; sequence: number };

/** The conversation identity of a canonical base document name, or null. */
function threadIdOf(name: string): string | null {
  const id = /^thread-([a-f0-9-]+)\.json$/u.exec(name)?.[1];
  try {
    return id && threadDocument(id) === name ? id : null;
  } catch {
    return null;
  }
}

/** Groups segment documents by conversation in journal order; other names are unexpected. */
function groupSegments(names: readonly string[]): {
  segments: Map<string, SegmentName[]>;
  unexpected: string[];
} {
  const segments = new Map<string, SegmentName[]>();
  const unexpected: string[] = [];
  for (const name of names) {
    const segment = parseThreadSegmentName(name);
    if (!segment) {
      unexpected.push(name);
      continue;
    }
    const list = segments.get(segment.id) ?? [];
    list.push({ name, sequence: segment.sequence });
    segments.set(segment.id, list);
  }
  for (const list of segments.values()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }
  return { segments, unexpected };
}

export class LocalThreadRepository {
  private readonly threads = new Map<string, LocalThread>();
  private readonly failures = new Map<string, Error>();
  private readonly persisted = new Map<string, PersistedThread>();
  private readonly queued = new Map<string, Promise<void>>();
  private readonly progress = new Map<string, ReturnType<typeof setTimeout>>();
  /** Conversations whose next write must be a new base, after startup set journal damage aside. */
  private readonly rebase = new Set<string>();
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
    // The base goes first: segments left by an interrupted delete have no base and are discarded
    // at the next startup instead of resurrecting the conversation.
    await this.storage.removeRuntimeDocument(threadDocument(id));
    const segments = await this.storage
      .listRuntimeDocuments(threadSegmentPrefix(id))
      .catch((): string[] => []);
    await Promise.allSettled(segments.map((name) => this.storage.removeRuntimeDocument(name)));
    this.threads.delete(id);
    this.failures.delete(id);
    this.persisted.delete(id);
    this.rebase.delete(id);
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
      if (thread) {
        await this.persist(id, thread);
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

  /**
   * Appends what changed since the last durable state as the next journal segment. A run that
   * settles, a change too large for a segment, or a journal that outgrew its base is compacted
   * into a new base instead.
   */
  private async persist(id: string, thread: LocalThread): Promise<void> {
    const durable = durableLocalThread(thread);
    const previous = this.persisted.get(id);
    const running = thread.status === 'running';
    if (previous && !this.rebase.has(id)) {
      const delta = localThreadDelta(previous.durable, thread, durable);
      if (delta === null) {
        return;
      }
      if (delta !== 'rebase' && !(previous.running && !running)) {
        const sequence = previous.sequence + 1;
        const contents = encodeLocalThreadSegment(id, sequence, delta);
        const bytes = utf8Bytes(contents);
        if (
          bytes <= THREAD_SEGMENT_MAX_BYTES &&
          previous.segments.length < THREAD_COMPACT_SEGMENTS &&
          previous.segmentBytes + bytes <= Math.max(previous.baseBytes, THREAD_COMPACT_MIN_BYTES)
        ) {
          await this.storage.writeRuntimeDocument(threadSegmentDocument(id, sequence), contents);
          this.persisted.set(id, {
            ...previous,
            durable,
            journal: journalEntries(thread),
            running,
            sequence,
            segments: [...previous.segments, sequence],
            segmentBytes: previous.segmentBytes + bytes,
          });
          return;
        }
      }
    }
    const sequence = previous?.sequence ?? 0;
    const contents = encodeLocalThreadBase(thread, sequence);
    await this.storage.writeRuntimeDocument(threadDocument(id), contents);
    this.rebase.delete(id);
    this.persisted.set(id, {
      durable,
      journal: journalEntries(thread),
      running,
      sequence,
      baseBytes: utf8Bytes(contents),
      segments: [],
      segmentBytes: 0,
    });
    // The new base contains these segments; any that cannot be removed are discarded at startup.
    await Promise.allSettled(
      (previous?.segments ?? []).map((segment) =>
        this.storage.removeRuntimeDocument(threadSegmentDocument(id, segment)),
      ),
    );
  }

  private async restore(): Promise<void> {
    const documents = await this.storage.listRuntimeDocuments('thread-');
    const segmentNames = await this.storage.listRuntimeDocuments(THREAD_SEGMENT_PREFIX);
    const loaded = new Map<string, LocalThread>();
    const recovered: string[] = [];
    const setAside = new Set<string>();
    const leftInPlace = new Set<string>();
    const quarantine = async (name: string, raw: string | null, id: string | undefined) => {
      const moved = await quarantineDocument(this.storage, name, raw);
      // Each conversation is counted once, however many of its documents were affected.
      (moved ? setAside : leftInPlace).add(id ?? name);
    };
    const { segments, unexpected } = groupSegments(segmentNames);
    for (const name of unexpected) {
      await quarantine(name, null, undefined);
    }
    const bases = new Set<string>();
    for (const name of documents) {
      const id = threadIdOf(name);
      if (!id) {
        await quarantine(name, null, undefined);
        continue;
      }
      let raw: string | null;
      try {
        raw = await this.storage.readRuntimeDocument(name);
      } catch {
        // Its segments stay untouched with it.
        bases.add(id);
        leftInPlace.add(id);
        continue;
      }
      if (raw === null) {
        continue;
      }
      bases.add(id);
      const journal = segments.get(id) ?? [];
      const restored = await this.restoreThread(id, raw, journal, (document, contents) =>
        quarantine(document, contents, id),
      );
      if (restored) {
        loaded.set(id, restored.thread);
        if (restored.recovered) {
          recovered.push(id);
        }
      }
    }
    // Segments without a base belong to a conversation whose deletion was interrupted.
    for (const [id, journal] of segments) {
      if (!bases.has(id)) {
        await Promise.allSettled(
          journal.map((segment) => this.storage.removeRuntimeDocument(segment.name)),
        );
      }
    }
    this.threads.clear();
    for (const [id, thread] of loaded) {
      this.threads.set(id, thread);
    }
    this.recoveryValue = {
      setAside: setAside.size,
      leftInPlace: leftInPlace.size,
      ids: new Set([...setAside, ...leftInPlace].filter((id) => bases.has(id))),
    };
    await Promise.allSettled(recovered.map((id) => this.write(id)));
    this.changed('persistence');
  }

  /** Loads one conversation from its base and journal; null when the base was set aside. */
  private async restoreThread(
    id: string,
    raw: string,
    journal: readonly SegmentName[],
    quarantine: (name: string, raw: string | null) => Promise<void>,
  ): Promise<{ thread: LocalThread; recovered: boolean } | null> {
    let base: { thread: LocalThread; sequence: number };
    try {
      base = parseLocalThreadBase(raw, id);
    } catch {
      await quarantine(threadDocument(id), raw);
      for (const segment of journal) {
        await quarantine(segment.name, null);
      }
      return null;
    }
    const replayed = await this.replay(id, base, journal, quarantine);
    if (replayed.damaged) {
      this.rebase.add(id);
    }
    this.persisted.set(id, {
      durable: durableLocalThread(replayed.thread),
      journal: journalEntries(replayed.thread),
      running: replayed.thread.status === 'running',
      sequence: replayed.sequence,
      baseBytes: utf8Bytes(raw),
      segments: replayed.segments,
      segmentBytes: replayed.segmentBytes,
    });
    const thread = recoverLocalThread(replayed.thread);
    return { thread, recovered: thread !== replayed.thread || replayed.damaged };
  }

  /**
   * Applies the contiguous segments after the base. A damaged, unreadable, or missing segment ends
   * the replay; it and every later segment are set aside with their bytes preserved, and the
   * position moves past all of them so new segments never reuse their names.
   */
  private async replay(
    id: string,
    base: { thread: LocalThread; sequence: number },
    journal: readonly SegmentName[],
    quarantine: (name: string, raw: string | null) => Promise<void>,
  ): Promise<{
    thread: LocalThread;
    sequence: number;
    segments: number[];
    segmentBytes: number;
    damaged: boolean;
  }> {
    let thread = base.thread;
    let applied = base.sequence;
    let highest = base.sequence;
    let damaged = false;
    let segmentBytes = 0;
    const segments: number[] = [];
    for (const segment of journal) {
      highest = Math.max(highest, segment.sequence);
      let raw: string | null;
      try {
        raw = await this.storage.readRuntimeDocument(segment.name);
      } catch {
        damaged ||= segment.sequence > base.sequence;
        await quarantine(segment.name, null);
        continue;
      }
      if (raw === null) {
        damaged ||= segment.sequence > base.sequence;
        continue;
      }
      let delta: LocalThreadDelta;
      try {
        delta = parseLocalThreadSegment(raw, id, segment.sequence);
      } catch {
        damaged ||= segment.sequence > base.sequence;
        await quarantine(segment.name, raw);
        continue;
      }
      if (segment.sequence <= base.sequence) {
        // Already contained in the base; compaction was interrupted before removing it.
        await this.storage.removeRuntimeDocument(segment.name).catch(() => undefined);
        continue;
      }
      if (damaged || segment.sequence !== applied + 1) {
        damaged = true;
        await quarantine(segment.name, raw);
        continue;
      }
      thread = applyLocalThreadDelta(thread, delta);
      applied = segment.sequence;
      segments.push(segment.sequence);
      segmentBytes += utf8Bytes(raw);
    }
    return { thread, sequence: damaged ? highest : applied, segments, segmentBytes, damaged };
  }
}
