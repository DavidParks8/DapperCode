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

/** The serialized form of the last durable state, used to compute the next segment. */
export interface DurableLocalThread {
  header: Record<LocalThreadHeaderKey, string>;
  ids: string[];
  messages: Map<string, string>;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
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

export function durableLocalThread(thread: LocalThread): DurableLocalThread {
  const header = {} as Record<LocalThreadHeaderKey, string>;
  for (const key of LOCAL_THREAD_HEADER_KEYS) {
    header[key] = JSON.stringify(thread[key]);
  }
  return {
    header,
    ids: thread.messages.map((message) => message.id),
    messages: new Map(thread.messages.map((message) => [message.id, JSON.stringify(message)])),
  };
}

/**
 * Describes how `next` differs from the durable state: null when nothing changed, or 'rebase' when
 * the change is not an in-place update/removal/append (for example reordered or duplicate ids)
 * and needs a new base.
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
    if (previous.header[key] !== durable.header[key]) {
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
      if (previous.messages.get(message.id) === durable.messages.get(message.id)) {
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
