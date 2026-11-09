import { isRecord } from '@shared/records';
import {
  LOCAL_THREAD_HEADER_KEYS,
  parseLocalJson,
  parseLocalMessage,
  parseLocalThreadField,
  threadDocument,
  type LocalThreadHeader,
  type LocalThreadHeaderKey,
} from './threadCodec';
import type { LocalMessage, LocalThread } from './types';

/**
 * A conversation is stored as a base document (`thread-<id>.json`, the whole thread plus the last
 * journal segment it contains) and append-only journal segments
 * (`threadseg-<id>-<sequence>.json`) holding only what changed since the previous one. Segments
 * use a prefix older builds never list, so a downgrade still reads the base.
 */
export const THREAD_SEGMENT_PREFIX = 'threadseg-';

/** The native runtime document store rejects documents larger than this. */
export const RUNTIME_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

/** A change larger than this is written as a new base instead of a segment. */
export const THREAD_SEGMENT_MAX_BYTES = 512 * 1024;

/** Segments since the base that trigger compaction into a new base. */
export const THREAD_COMPACT_SEGMENTS = 64;

/**
 * Segment bytes since the base that trigger compaction: the base size, but at least this much,
 * which keeps rewrites of large conversations amortized and startup replay bounded.
 */
export const THREAD_COMPACT_MIN_BYTES = 256 * 1024;

const SEGMENT_NAME = /^threadseg-([a-f0-9-]{36})-(\d{10,})\.json$/u;

export interface LocalThreadDelta {
  /** Conversation fields that changed. */
  set: Partial<LocalThreadHeader>;
  /** Messages that were removed. */
  remove: string[];
  /** Changed messages, replaced by id, followed by new messages in order. */
  messages: LocalMessage[];
}

/**
 * The last durable state, used to compute the next segment. It references the conversation's own
 * (immutable) message objects instead of copying them, so it costs no serialization and no memory
 * beyond the id index.
 */
export interface DurableLocalThread {
  header: LocalThreadHeader;
  ids: string[];
  messages: Map<string, LocalMessage>;
}

/** The UTF-8 length of `value`, as `TextEncoder` encodes it, without allocating the bytes. */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // A lone surrogate is encoded as U+FFFD.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Whether two values serialize to the same JSON, without serializing them. Properties whose value
 * is undefined are skipped and key order matters, exactly as in `JSON.stringify`, so this matches
 * comparing the serialized strings for conversation data (strings, null, booleans, finite numbers,
 * arrays, and plain objects).
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => sameJson(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const other = Object.keys(right).filter((key) => right[key] !== undefined);
  return (
    keys.length === other.length &&
    keys.every((key, index) => key === other[index] && sameJson(left[key], right[key]))
  );
}

export function threadSegmentPrefix(id: string): string {
  return `${THREAD_SEGMENT_PREFIX}${threadDocument(id).slice('thread-'.length, -'.json'.length)}-`;
}

export function threadSegmentDocument(id: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Invalid local conversation journal position.');
  }
  return `${threadSegmentPrefix(id)}${String(sequence).padStart(10, '0')}.json`;
}

/** Returns the identity and position of a canonical segment name, or null for anything else. */
export function parseThreadSegmentName(name: string): { id: string; sequence: number } | null {
  const match = SEGMENT_NAME.exec(name);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const id = match[1];
  const sequence = Number(match[2]);
  try {
    return threadSegmentDocument(id, sequence) === name ? { id, sequence } : null;
  } catch {
    return null;
  }
}

export type SegmentName = { name: string; sequence: number };

/** Groups segment documents by conversation in journal order; other names are unexpected. */
export function groupSegments(names: readonly string[]): {
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

export function durableLocalThread(thread: LocalThread): DurableLocalThread {
  const header = {} as Record<LocalThreadHeaderKey, unknown>;
  for (const key of LOCAL_THREAD_HEADER_KEYS) {
    header[key] = thread[key];
  }
  return {
    header: header as LocalThreadHeader,
    ids: thread.messages.map((message) => message.id),
    messages: new Map(thread.messages.map((message) => [message.id, message])),
  };
}

/**
 * Describes how `next` differs from the durable state: null when nothing changed, or 'rebase' when
 * the change is not an in-place update/removal/append (for example reordered or duplicate ids)
 * and needs a new base. Messages are never changed in place, so an unchanged object is skipped by
 * identity; only a replaced object is compared by content.
 */
export function localThreadDelta(
  previous: DurableLocalThread,
  next: LocalThread,
  durable: DurableLocalThread,
): LocalThreadDelta | null | 'rebase' {
  if (
    previous.messages.size !== previous.ids.length ||
    durable.messages.size !== durable.ids.length
  ) {
    return 'rebase';
  }
  const set: Partial<LocalThreadHeader> = {};
  let changed = false;
  for (const key of LOCAL_THREAD_HEADER_KEYS) {
    if (!sameJson(previous.header[key], durable.header[key])) {
      Object.assign(set, { [key]: next[key] });
      changed = true;
    }
  }
  const remove = previous.ids.filter((id) => !durable.messages.has(id));
  const kept = previous.ids.filter((id) => durable.messages.has(id));
  const messages: LocalMessage[] = [];
  for (const [index, message] of next.messages.entries()) {
    if (index < kept.length) {
      if (kept[index] !== message.id) {
        return 'rebase';
      }
      if (sameJson(previous.messages.get(message.id), durable.messages.get(message.id))) {
        continue;
      }
    }
    messages.push(message);
  }
  if (!changed && remove.length === 0 && messages.length === 0) {
    return null;
  }
  return { set, remove, messages };
}

export function encodeLocalThreadBase(
  thread: LocalThread,
  sequence: number,
  skipped: readonly number[] = [],
): string {
  return JSON.stringify({ ...thread, segment: sequence, ...(skipped.length ? { skipped } : {}) });
}

export function encodeLocalThreadSegment(
  id: string,
  sequence: number,
  delta: LocalThreadDelta,
): string {
  return JSON.stringify({ version: 1, thread: id, sequence, ...delta });
}

export function parseLocalThreadSegment(
  raw: string,
  expectedId: string,
  expectedSequence: number,
): LocalThreadDelta {
  const item = parseLocalJson(raw);
  if (
    !isRecord(item) ||
    item['version'] !== 1 ||
    item['thread'] !== expectedId ||
    item['sequence'] !== expectedSequence ||
    !isRecord(item['set']) ||
    !Array.isArray(item['remove']) ||
    !Array.isArray(item['messages'])
  ) {
    throw new Error('The local conversation journal segment is invalid.');
  }
  const set: Partial<LocalThreadHeader> = {};
  for (const [key, value] of Object.entries(item['set'])) {
    if (!(LOCAL_THREAD_HEADER_KEYS as readonly string[]).includes(key)) {
      throw new Error('The local conversation journal segment is invalid.');
    }
    Object.assign(set, { [key]: parseLocalThreadField(key as LocalThreadHeaderKey, value) });
  }
  const remove = item['remove'].map((id) => {
    if (typeof id !== 'string' || !id) {
      throw new Error('The local conversation journal segment is invalid.');
    }
    return id;
  });
  return { set, remove, messages: item['messages'].map(parseLocalMessage) };
}

export function applyLocalThreadDelta(thread: LocalThread, delta: LocalThreadDelta): LocalThread {
  const removed = new Set(delta.remove);
  const messages = thread.messages.filter((message) => !removed.has(message.id));
  const index = new Map(messages.map((message, position) => [message.id, position]));
  for (const message of delta.messages) {
    const position = index.get(message.id);
    if (position === undefined) {
      index.set(message.id, messages.length);
      messages.push(message);
    } else {
      messages[position] = message;
    }
  }
  return { ...thread, ...delta.set, messages };
}

/** Journal entries (user turns, tool results, tool-call intent) with their durable counts. */
export type JournalEntries = Map<string, number>;

export function messageJournalEntries(message: LocalMessage): string[] {
  const entries = message.role === 'assistant' ? [] : [`message:${message.id}`];
  for (const call of message.toolCalls ?? []) {
    entries.push(`call:${call.id}`);
  }
  for (const child of message.children ?? []) {
    entries.push(`child:${child.id}`);
    for (const entry of child.messages) {
      entries.push(...messageJournalEntries(entry));
    }
  }
  return entries;
}

export function countJournalEntries(
  journal: JournalEntries,
  message: LocalMessage | undefined,
  step: 1 | -1,
): void {
  for (const entry of message ? messageJournalEntries(message) : []) {
    const count = (journal.get(entry) ?? 0) + step;
    if (count > 0) {
      journal.set(entry, count);
    } else {
      journal.delete(entry);
    }
  }
}

export function journalEntries(thread: LocalThread): JournalEntries {
  const journal: JournalEntries = new Map();
  for (const message of thread.messages) {
    countJournalEntries(journal, message, 1);
  }
  return journal;
}
