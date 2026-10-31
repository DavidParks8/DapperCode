import { isRecord } from '@shared/records';
import { quarantineDocument } from './quarantine';
import { threadDocument } from './threadCodec';
import type { LocalDocumentPort } from './threads';

export const DRAFT_PREFIX = 'draft-';

/** The per-conversation draft document written by builds before the shared chat shell. */
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

/** Called once a legacy inline draft is obsolete or settled elsewhere and may be dropped. */
export type LegacyDraftSettled = (threadId: string) => void;

/**
 * How the shell's composer took a legacy draft: `imported` once its draft store durably holds the
 * text, `superseded` when the chat already had a different, newer composer draft.
 */
export type LegacyDraftOutcome = 'imported' | 'superseded';

/**
 * Read-only access to drafts written by older builds: per-conversation draft documents and drafts
 * stored inline in `preferences.json`. Nothing writes drafts here any more; the shared composer
 * owns them. A legacy draft's bytes are only removed (or, when superseded, set aside) after the
 * composer has confirmed it, so an interrupted import is simply retried at the next start.
 */
export class LegacyDraftReader {
  private readonly values = new Map<string, string>();
  private readonly documents = new Set<string>();
  private readonly inline = new Set<string>();
  private legacySettled: LegacyDraftSettled = () => undefined;

  constructor(private readonly storage: LocalDocumentPort) {}

  /** Drafts still waiting for the composer, by conversation id. */
  pending(): ReadonlyMap<string, string> {
    return this.values;
  }

  /**
   * Loads draft documents for known conversations, sets damaged ones aside, prunes drafts whose
   * conversation was deleted, and adds inline legacy drafts that have no document of their own.
   */
  async restore(
    known: ReadonlySet<string>,
    preserved: ReadonlySet<string>,
    legacy: Readonly<Record<string, string>>,
    settled: LegacyDraftSettled,
  ): Promise<LocalDraftRestore> {
    this.legacySettled = settled;
    const result: LocalDraftRestore = { setAside: 0, leftInPlace: 0 };
    const unreadable = new Set<string>();
    for (const name of await this.storage.listRuntimeDocuments(DRAFT_PREFIX)) {
      const outcome = await this.restoreDocument(name, known, preserved, unreadable);
      if (outcome !== 'loaded') {
        result[outcome] += 1;
      }
    }
    for (const [threadId, text] of Object.entries(legacy)) {
      if (unreadable.has(threadId)) {
        // Never settle a legacy copy while its draft document could not be read.
        continue;
      }
      const retained = known.has(threadId) || preserved.has(threadId);
      if (!text || !retained || this.documents.has(threadId)) {
        // A draft document is newer than the inline copy it replaced.
        settled(threadId);
        continue;
      }
      if (known.has(threadId)) {
        this.values.set(threadId, text);
        this.inline.add(threadId);
      }
    }
    return result;
  }

  /** Drops (or sets aside) a draft the composer has confirmed. Throws if its bytes remain. */
  async settle(threadId: string, outcome: LegacyDraftOutcome): Promise<void> {
    const text = this.values.get(threadId);
    if (text === undefined) {
      return;
    }
    const name = draftDocument(threadId);
    if (outcome === 'superseded') {
      const contents = this.documents.has(threadId)
        ? undefined
        : JSON.stringify({ version: 1, text });
      if (!(await quarantineDocument(this.storage, name, contents))) {
        throw new Error('An older local draft could not be set aside.');
      }
    } else if (this.documents.has(threadId)) {
      await this.storage.removeRuntimeDocument(name);
    }
    this.values.delete(threadId);
    this.documents.delete(threadId);
    if (this.inline.delete(threadId)) {
      this.legacySettled(threadId);
    }
  }

  /** Discards a draft and its document when its conversation is deleted. */
  async remove(threadId: string): Promise<void> {
    this.values.delete(threadId);
    this.inline.delete(threadId);
    this.documents.delete(threadId);
    await this.storage.removeRuntimeDocument(draftDocument(threadId));
  }

  private async restoreDocument(
    name: string,
    known: ReadonlySet<string>,
    preserved: ReadonlySet<string>,
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
        this.documents.add(threadId);
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
        this.documents.add(threadId);
      }
      return 'loaded';
    } catch {
      return (await quarantineDocument(this.storage, name, raw)) ? 'setAside' : 'leftInPlace';
    }
  }
}
