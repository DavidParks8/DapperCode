import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import {
  CHAT_SUBMISSION_IDEMPOTENCY_VERSION,
  ProfilePersistenceError,
  type ProfilePersistenceStorage,
  getChatSubmissionIdempotencyPath,
  getWebProfilePersistenceKey,
} from '../mainScreenHelpers';

/**
 * Persists only `{ scopeKey, requestHash } -> submissionId` so a user-initiated retry after a
 * restart can reuse the same submission id. This is deliberately NOT an outbox: prompt content is
 * never written to disk (a stable hash stands in for it), and nothing here is ever read back and
 * resent automatically — a submission id is only reused when the user re-submits matching content
 * themselves via `SubmissionController.begin`.
 */

export type SubmissionIdempotencyStorage = ProfilePersistenceStorage;

export interface SubmissionIdempotencyRecord {
  submissionId: string;
  updatedAt: number;
}

/** Read/record/clear surface `SubmissionController` depends on; kept separate from the concrete
 * cache implementation below so the controller can be unit tested with a plain in-memory fake. */
export interface SubmissionIdempotencyStore {
  lookup(scopeKey: string, requestHash: string): string | null;
  record(scopeKey: string, requestHash: string, submissionId: string): void;
  clear(scopeKey: string, requestHash: string): void;
}

export const SUBMISSION_IDEMPOTENCY_LIMIT = 32;
export const SUBMISSION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_SEPARATOR = '\u0000';

const fileStorage: SubmissionIdempotencyStorage = {
  read: FileSystem.readAsStringAsync,
  write: FileSystem.writeAsStringAsync,
  exists: async (path) => (await FileSystem.getInfoAsync(path))?.exists === true,
};

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const webStorage: SubmissionIdempotencyStorage = {
  read: async (key) => {
    const value = getWebStorage()?.getItem(key);
    if (value == null) throw new Error('missing');
    return value;
  },
  write: async (key, value) => {
    const storage = getWebStorage();
    if (!storage) throw new Error('Browser storage is unavailable.');
    storage.setItem(key, value);
  },
  exists: async (key) => getWebStorage()?.getItem(key) != null,
};

function getWebStorage(): WebStorageLike | null {
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const storage = (globalThis as typeof globalThis & { localStorage?: Partial<WebStorageLike> })
    .localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? (storage as WebStorageLike)
    : null;
}

/** A fast, deterministic, non-cryptographic 64-bit hash (two salted FNV-1a passes). Collisions
 * only ever cost a missed retry-id reuse, never data loss, so this favors speed and staying
 * synchronous over cryptographic strength. */
function fnv1a(value: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hashSubmissionRequest(
  draft: string,
  attachments: { mentions: readonly string[]; localImages: readonly string[] },
): string {
  const payload = JSON.stringify([draft, attachments.mentions, attachments.localImages]);
  const low = fnv1a(payload, 0x811c9dc5);
  const high = fnv1a(payload, 0x9e3779b9 ^ low);
  return `${low.toString(16).padStart(8, '0')}${high.toString(16).padStart(8, '0')}`;
}

function buildKey(scopeKey: string, requestHash: string): string {
  return `${scopeKey}${KEY_SEPARATOR}${requestHash}`;
}

export function pruneSubmissionIdempotencyEntries(
  entries: Readonly<Record<string, SubmissionIdempotencyRecord>>,
  now: number,
  limit: number = SUBMISSION_IDEMPOTENCY_LIMIT,
  ttlMs: number = SUBMISSION_IDEMPOTENCY_TTL_MS,
): Record<string, SubmissionIdempotencyRecord> {
  const fresh = Object.entries(entries).filter(([, record]) => now - record.updatedAt <= ttlMs);
  fresh.sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
  const bounded = fresh.slice(Math.max(0, fresh.length - limit));
  return Object.fromEntries(bounded);
}

export function serializeSubmissionIdempotencyEntries(
  entries: Readonly<Record<string, SubmissionIdempotencyRecord>>,
): string {
  return JSON.stringify({ version: CHAT_SUBMISSION_IDEMPOTENCY_VERSION, entries });
}

export function parseSubmissionIdempotencyEntries(
  raw: string,
  now: number,
): Record<string, SubmissionIdempotencyRecord> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      entries?: unknown;
    };
    if (
      parsed?.version !== CHAT_SUBMISSION_IDEMPOTENCY_VERSION ||
      typeof parsed.entries !== 'object' ||
      parsed.entries === null
    ) {
      return {};
    }

    const result: Record<string, SubmissionIdempotencyRecord> = {};
    for (const [key, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
      const record = value as Partial<SubmissionIdempotencyRecord> | null;
      const submissionId =
        typeof record?.submissionId === 'string' ? record.submissionId.trim() : '';
      const updatedAt = typeof record?.updatedAt === 'number' ? record.updatedAt : NaN;
      if (!key.trim() || !submissionId || !Number.isFinite(updatedAt)) {
        continue;
      }
      result[key] = { submissionId, updatedAt };
    }
    return pruneSubmissionIdempotencyEntries(result, now);
  } catch {
    return {};
  }
}

export interface SubmissionIdempotencyCacheOptions {
  profileId: string;
  storage?: SubmissionIdempotencyStorage;
  platform?: string;
  now?: () => number;
  limit?: number;
  ttlMs?: number;
  onPersistenceError?: (error: ProfilePersistenceError) => void;
}

/**
 * Loads and saves the idempotency mapping for a single bridge profile. All chats/threads and
 * agents for that profile share one file, scoped internally by `scopeKey` (which already encodes
 * profile + thread — see `submissionScopeKey`), matching how chat drafts are scoped.
 */
export class SubmissionIdempotencyCache implements SubmissionIdempotencyStore {
  private readonly storage: SubmissionIdempotencyStorage;
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly onPersistenceError?: (error: ProfilePersistenceError) => void;
  private entries: Record<string, SubmissionIdempotencyRecord> = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SubmissionIdempotencyCacheOptions) {
    const {
      profileId,
      storage,
      platform = Platform.OS,
      now,
      limit,
      ttlMs,
      onPersistenceError,
    } = options;
    this.storage = storage ?? (platform === 'web' ? webStorage : fileStorage);
    this.path =
      platform === 'web'
        ? getWebProfilePersistenceKey('submission-idempotency.v1', profileId)
        : getChatSubmissionIdempotencyPath(profileId);
    this.now = now ?? (() => Date.now());
    this.limit = limit ?? SUBMISSION_IDEMPOTENCY_LIMIT;
    this.ttlMs = ttlMs ?? SUBMISSION_IDEMPOTENCY_TTL_MS;
    this.onPersistenceError = onPersistenceError;
  }

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = await this.storage.read(this.path);
      this.entries = parseSubmissionIdempotencyEntries(raw, this.now());
    } catch {
      this.entries = {};
    }
  }

  lookup(scopeKey: string, requestHash: string): string | null {
    const key = buildKey(scopeKey, requestHash);
    const record = this.entries[key];
    if (!record) return null;
    if (this.now() - record.updatedAt > this.ttlMs) {
      delete this.entries[key];
      return null;
    }
    return record.submissionId;
  }

  record(scopeKey: string, requestHash: string, submissionId: string): void {
    const key = buildKey(scopeKey, requestHash);
    this.entries = pruneSubmissionIdempotencyEntries(
      { ...this.entries, [key]: { submissionId, updatedAt: this.now() } },
      this.now(),
      this.limit,
      this.ttlMs,
    );
    this.persist();
  }

  clear(scopeKey: string, requestHash: string): void {
    const key = buildKey(scopeKey, requestHash);
    if (!(key in this.entries)) return;
    const next = { ...this.entries };
    delete next[key];
    this.entries = next;
    this.persist();
  }

  /** Exposed for tests that need to await the in-flight write before asserting on storage. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private persist(): void {
    if (!this.path) return;
    const path = this.path;
    const snapshot = this.entries;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.storage.write(path, serializeSubmissionIdempotencyEntries(snapshot));
        } catch (cause) {
          this.onPersistenceError?.(
            new ProfilePersistenceError('submission retries', 'write', { cause }),
          );
        }
      });
  }
}
