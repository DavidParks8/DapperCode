import { isRecord } from '@shared/records';
import { quarantineDocument } from './quarantine';
import { threadDocument } from './threadCodec';
import type { LocalDocumentPort } from './threads';

export const DRAFT_PREFIX = 'draft-';
/** Typing is saved after this pause, and only the edited conversation's draft is rewritten. */
export const DRAFT_SAVE_DELAY_MS = 400;

export function draftDocument(threadId: string): string {
  return threadDocument(threadId).replace(/^thread-/u, DRAFT_PREFIX);
}

function parseDraft(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value['version'] !== 1 || typeof value['text'] !== 'string') {
    throw new Error('A local draft is invalid.');
  }
  return value['text'];
}

export interface LocalDraftRestore {
  setAside: number;
  leftInPlace: number;
}

/** Called once a legacy inline draft is durable elsewhere (or obsolete) and may be dropped. */
export type LegacyDraftSettled = (threadId: string) => void;

export class LocalDraftStore {
  private readonly values = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly failures = new Map<string, Error>();
  /** Legacy inline drafts whose draft document has not been written yet. */
  private readonly migrating = new Set<string>();
  private legacySettled: LegacyDraftSettled = () => undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: LocalDocumentPort,
    private readonly changed: () => void,
    private readonly delayMs = DRAFT_SAVE_DELAY_MS,
  ) {}

  get(threadId: string): string {
    return this.values.get(threadId) ?? '';
  }

  set(threadId: string, text: string): void {
    draftDocument(threadId);
    if (this.get(threadId) === text) {
      return;
    }
    if (text) {
      this.values.set(threadId, text);
    } else {
      this.values.delete(threadId);
    }
    this.dirty.add(threadId);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.delayMs);
  }

  failure(): Error | null {
    return this.failures.values().next().value ?? null;
  }

  /** Discards a draft and its document, e.g. when its conversation is deleted. */
  async remove(threadId: string): Promise<void> {
    this.values.delete(threadId);
    this.dirty.delete(threadId);
    this.migrating.delete(threadId);
    await this.writes;
    await this.storage.removeRuntimeDocument(draftDocument(threadId));
    if (this.failures.delete(threadId)) {
      this.changed();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = [...new Set([...this.dirty, ...this.failures.keys()])];
    this.dirty.clear();
    for (const threadId of pending) {
      await this.write(threadId).catch(() => undefined);
    }
    await this.writes;
    const failure = this.failure();
    if (failure) {
      throw failure;
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Loads draft documents for known conversations, sets damaged ones aside, prunes drafts whose
   * conversation was deleted, and moves inline legacy drafts into their own documents. A legacy
   * draft is reported as settled only after its document write succeeds (or when it is obsolete),
   * so the caller keeps it in preferences until then.
   */
  async restore(
    known: ReadonlySet<string>,
    preserved: ReadonlySet<string>,
    legacy: Readonly<Record<string, string>>,
    settled: LegacyDraftSettled,
  ): Promise<LocalDraftRestore> {
    this.legacySettled = settled;
    const result: LocalDraftRestore = { setAside: 0, leftInPlace: 0 };
    const present = new Set<string>();
    const unreadable = new Set<string>();
    for (const name of await this.storage.listRuntimeDocuments(DRAFT_PREFIX)) {
      const outcome = await this.restoreDocument(name, known, preserved, present, unreadable);
      if (outcome !== 'loaded') {
        result[outcome] += 1;
      }
    }
    for (const [threadId, text] of Object.entries(legacy)) {
      if (unreadable.has(threadId)) {
        // Never overwrite a draft document that could not be read; keep the legacy copy.
        continue;
      }
      const retained = known.has(threadId) || preserved.has(threadId);
      if (!text || !retained || present.has(threadId) || this.values.has(threadId)) {
        settled(threadId);
        continue;
      }
      this.values.set(threadId, text);
      this.dirty.add(threadId);
      this.migrating.add(threadId);
    }
    if (this.migrating.size > 0) {
      // Failures stay recorded and retried; unconfirmed legacy drafts stay in preferences.
      await this.flush().catch(() => undefined);
    }
    return result;
  }

  private async restoreDocument(
    name: string,
    known: ReadonlySet<string>,
    preserved: ReadonlySet<string>,
    present: Set<string>,
    unreadable: Set<string>,
  ): Promise<'loaded' | 'setAside' | 'leftInPlace'> {
    const threadId = /^draft-([a-f0-9-]+)\.json$/u.exec(name)?.[1];
    let valid = false;
    try {
      valid = Boolean(threadId && draftDocument(threadId) === name);
    } catch {
      valid = false;
    }
    if (!threadId || !valid) {
      return (await quarantineDocument(this.storage, name)) ? 'setAside' : 'leftInPlace';
    }
    if (!known.has(threadId)) {
      if (preserved.has(threadId)) {
        present.add(threadId);
      } else {
        await this.storage.removeRuntimeDocument(name).catch(() => undefined);
      }
      return 'loaded';
    }
    let raw: string | null;
    try {
      raw = await this.storage.readRuntimeDocument(name);
    } catch {
      unreadable.add(threadId);
      return 'leftInPlace';
    }
    try {
      const text = raw === null ? '' : parseDraft(raw);
      if (text) {
        this.values.set(threadId, text);
      }
      return 'loaded';
    } catch {
      return (await quarantineDocument(this.storage, name, raw)) ? 'setAside' : 'leftInPlace';
    }
  }

  private write(threadId: string): Promise<void> {
    const write = this.writes.then(async () => {
      const text = this.values.get(threadId);
      const name = draftDocument(threadId);
      if (text) {
        await this.storage.writeRuntimeDocument(name, JSON.stringify({ version: 1, text }));
      } else {
        await this.storage.removeRuntimeDocument(name);
      }
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(
      () => {
        if (this.migrating.delete(threadId)) {
          this.legacySettled(threadId);
        }
        if (this.failures.delete(threadId)) {
          this.changed();
        }
      },
      (error: unknown) => {
        this.failures.set(
          threadId,
          error instanceof Error ? error : new Error('A local draft could not be saved.'),
        );
        this.changed();
        throw error;
      },
    );
  }
}
