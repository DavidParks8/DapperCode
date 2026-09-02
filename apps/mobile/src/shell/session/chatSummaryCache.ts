import * as FileSystem from 'expo-file-system/legacy';

import type { ChatSummary } from '@bridge/types/types';
import {
  cloneChatSummaries,
  cloneChatSummary,
} from '@bridge/client/clientChatCloneAndRetryInternals';

export const CHAT_SUMMARY_CACHE_VERSION = 1;
export const CHAT_SUMMARY_CACHE_MAX_ENTRIES = 200;
export const CHAT_SUMMARY_CACHE_MAX_BYTES = 512 * 1024;
export const CHAT_SUMMARY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ChatSummaryCacheEntry {
  summary: ChatSummary;
  cachedAt: string;
}

export interface ChatSummaryCache {
  version: 1;
  profileId: string;
  updatedAt: string;
  lastSuccessfulRefreshAt: string | null;
  entries: ChatSummaryCacheEntry[];
}

const operationChains = new Map<string, Promise<unknown>>();

/**
 * Per-profile purge generation barrier. Deleting/clearing a profile's cache
 * (or rewriting it under an in-place bridge identity edit) bumps the
 * profile's generation synchronously, *before* the purge itself is queued.
 * Callers that captured a generation earlier - e.g. a drawer debounce timer
 * that buffered pending summaries before the purge happened - pass that
 * stale generation back in when they eventually flush. Because the check
 * runs inside the queued write itself (not at schedule time), any write
 * whose captured generation no longer matches the current one is dropped
 * instead of resurrecting or repopulating data the purge already removed.
 */
const purgeGenerations = new Map<string, number>();

export function getChatSummaryCacheGeneration(profileId: string): number {
  return purgeGenerations.get(profileId) ?? 0;
}

function bumpChatSummaryCacheGeneration(profileId: string): number {
  const next = getChatSummaryCacheGeneration(profileId) + 1;
  purgeGenerations.set(profileId, next);
  return next;
}

function isGenerationCurrent(profileId: string, generation: number): boolean {
  return getChatSummaryCacheGeneration(profileId) === generation;
}

export function createEmptyChatSummaryCache(
  profileId: string,
  now = new Date().toISOString(),
): ChatSummaryCache {
  return {
    version: CHAT_SUMMARY_CACHE_VERSION,
    profileId,
    updatedAt: now,
    lastSuccessfulRefreshAt: null,
    entries: [],
  };
}

export function parseChatSummaryCache(
  raw: string,
  profileId: string,
  now = Date.now(),
): ChatSummaryCache {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyChatSummaryCache(profileId, new Date(now).toISOString());
    }
    const record = parsed as Record<string, unknown>;
    if (record['profileId'] !== profileId) {
      return createEmptyChatSummaryCache(profileId, new Date(now).toISOString());
    }

    const cache = parseCurrentCache(record, profileId, now);
    if (!cache) {
      return createEmptyChatSummaryCache(profileId, new Date(now).toISOString());
    }
    const entries = cache.entries
      .map(normalizeEntry)
      .filter((entry): entry is ChatSummaryCacheEntry => entry !== null)
      .filter((entry) => now - Date.parse(entry.cachedAt) <= CHAT_SUMMARY_CACHE_MAX_AGE_MS);
    return boundChatSummaryCache({
      ...cache,
      entries,
    });
  } catch {
    return createEmptyChatSummaryCache(profileId, new Date(now).toISOString());
  }
}

export function mergeChatSummaryCache(
  cache: ChatSummaryCache,
  incoming: readonly ChatSummary[],
  now = new Date().toISOString(),
): ChatSummaryCache {
  const entriesById = new Map(cache.entries.map((entry) => [entry.summary.id, entry]));
  for (const summary of incoming) {
    const normalized = normalizeSummary(summary);
    if (!normalized) {
      continue;
    }
    const existing = entriesById.get(normalized.id);
    if (!existing || shouldReplaceSummary(existing.summary, normalized)) {
      entriesById.set(normalized.id, { summary: normalized, cachedAt: now });
    }
  }
  return boundChatSummaryCache({
    version: CHAT_SUMMARY_CACHE_VERSION,
    profileId: cache.profileId,
    updatedAt: now,
    lastSuccessfulRefreshAt: now,
    entries: [...entriesById.values()],
  });
}

export function removeChatSummaryFromCache(
  cache: ChatSummaryCache,
  chatId: string,
  now = new Date().toISOString(),
): ChatSummaryCache {
  const normalizedId = chatId.trim();
  return boundChatSummaryCache({
    ...cache,
    updatedAt: now,
    entries: cache.entries.filter((entry) => entry.summary.id !== normalizedId),
  });
}

export function reconcileChatSummaryCache(
  cache: ChatSummaryCache,
  authoritative: readonly ChatSummary[],
  now = new Date().toISOString(),
): ChatSummaryCache {
  const entriesById = new Map<string, ChatSummaryCacheEntry>();
  for (const summary of authoritative) {
    const normalized = normalizeSummary(summary);
    if (!normalized) {
      continue;
    }
    const existing = entriesById.get(normalized.id);
    if (!existing || shouldReplaceSummary(existing.summary, normalized)) {
      entriesById.set(normalized.id, { summary: normalized, cachedAt: now });
    }
  }
  return boundChatSummaryCache({
    version: CHAT_SUMMARY_CACHE_VERSION,
    profileId: cache.profileId,
    updatedAt: now,
    lastSuccessfulRefreshAt: now,
    entries: [...entriesById.values()],
  });
}

export async function loadChatSummaryCache(profileId: string): Promise<ChatSummaryCache> {
  const path = getChatSummaryCachePath(profileId);
  if (!path) {
    return createEmptyChatSummaryCache(profileId);
  }
  await operationChains.get(path)?.catch(() => {});
  return readCache(path, profileId);
}

export function saveChatSummaryCache(cache: ChatSummaryCache): Promise<void> {
  const path = getChatSummaryCachePath(cache.profileId);
  if (!path) {
    return Promise.resolve();
  }
  const bounded = boundChatSummaryCache(cache);
  return enqueue(path, async () => {
    await writeCache(path, bounded);
  });
}

export function persistChatSummaries(
  profileId: string,
  summaries: readonly ChatSummary[],
  now = new Date().toISOString(),
  generation: number = getChatSummaryCacheGeneration(profileId),
): Promise<void> {
  const path = getChatSummaryCachePath(profileId);
  if (!path) {
    return Promise.resolve();
  }
  const cloned = cloneChatSummaries([...summaries]);
  return enqueue(path, async () => {
    if (!isGenerationCurrent(profileId, generation)) {
      return;
    }
    const current = await readCache(path, profileId);
    await writeCache(path, mergeChatSummaryCache(current, cloned, now));
  });
}

export function reconcilePersistedChatSummaries(
  profileId: string,
  summaries: readonly ChatSummary[],
  now = new Date().toISOString(),
  generation: number = getChatSummaryCacheGeneration(profileId),
): Promise<void> {
  const path = getChatSummaryCachePath(profileId);
  if (!path) {
    return Promise.resolve();
  }
  const cloned = cloneChatSummaries([...summaries]);
  return enqueue(path, async () => {
    if (!isGenerationCurrent(profileId, generation)) {
      return;
    }
    const current = await readCache(path, profileId);
    await writeCache(path, reconcileChatSummaryCache(current, cloned, now));
  });
}

export function deletePersistedChatSummary(
  profileId: string,
  chatId: string,
  now = new Date().toISOString(),
  generation: number = getChatSummaryCacheGeneration(profileId),
): Promise<void> {
  const path = getChatSummaryCachePath(profileId);
  if (!path || !chatId.trim()) {
    return Promise.resolve();
  }
  return enqueue(path, async () => {
    if (!isGenerationCurrent(profileId, generation)) {
      return;
    }
    const current = await readCache(path, profileId);
    await writeCache(path, removeChatSummaryFromCache(current, chatId, now));
  });
}

export function deleteChatSummaryCache(profileId: string): Promise<void> {
  // Bump the barrier synchronously, before the deletion itself is queued, so
  // any generation captured by a caller up to this point is immediately
  // stale - even if their queued write only runs (or is only issued) later.
  bumpChatSummaryCacheGeneration(profileId);
  const path = getChatSummaryCachePath(profileId);
  if (!path) {
    return Promise.resolve();
  }
  return enqueue(path, async () => {
    try {
      await FileSystem.deleteAsync(path, { idempotent: true });
    } catch {
      // Cache cleanup is best effort.
    }
  });
}

export function getChatSummaryCachePath(
  profileId: string,
  base = FileSystem.documentDirectory,
): string | null {
  if (typeof base !== 'string' || !base || !profileId.trim()) {
    return null;
  }
  return `${base}dappercode-chat-cache/${encodeURIComponent(profileId)}/summaries.json`;
}

function parseCurrentCache(
  parsed: Record<string, unknown>,
  profileId: string,
  now: number,
): ChatSummaryCache | null {
  if (parsed['version'] !== CHAT_SUMMARY_CACHE_VERSION || !Array.isArray(parsed['entries'])) {
    return null;
  }
  return {
    version: CHAT_SUMMARY_CACHE_VERSION,
    profileId,
    updatedAt: normalizeTimestamp(parsed['updatedAt'], now),
    lastSuccessfulRefreshAt: normalizeNullableTimestamp(parsed['lastSuccessfulRefreshAt']),
    entries: parsed['entries'] as ChatSummaryCacheEntry[],
  };
}

function normalizeEntry(value: unknown): ChatSummaryCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entry = value as Partial<ChatSummaryCacheEntry>;
  const summary = normalizeSummary(entry.summary);
  if (
    !summary ||
    typeof entry.cachedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.cachedAt))
  ) {
    return null;
  }
  return { summary, cachedAt: entry.cachedAt };
}

function normalizeSummary(value: unknown): ChatSummary | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const summary = value as Record<string, unknown>;
  if (
    typeof summary['id'] !== 'string' ||
    !summary['id'].trim() ||
    typeof summary['title'] !== 'string' ||
    !isChatStatus(summary['status']) ||
    !isTimestamp(summary['createdAt']) ||
    !isTimestamp(summary['updatedAt']) ||
    !isTimestamp(summary['statusUpdatedAt']) ||
    typeof summary['lastMessagePreview'] !== 'string'
  ) {
    return null;
  }
  return {
    id: summary['id'],
    title: summary['title'],
    status: summary['status'],
    createdAt: summary['createdAt'],
    updatedAt: summary['updatedAt'],
    statusUpdatedAt: summary['statusUpdatedAt'],
    lastMessagePreview: summary['lastMessagePreview'],
    ...optionalBoolean(summary, 'timestampsSynthesized'),
    ...optionalString(summary, 'cwd'),
    ...optionalNullableString(summary, 'agentId'),
    ...optionalString(summary, 'modelProvider'),
    ...optionalString(summary, 'agentNickname'),
    ...optionalString(summary, 'agentRole'),
    ...optionalString(summary, 'sourceKind'),
    ...optionalString(summary, 'parentThreadId'),
    ...optionalNumber(summary, 'subAgentDepth'),
    ...optionalString(summary, 'lastRunStartedAt'),
    ...optionalString(summary, 'lastRunFinishedAt'),
    ...optionalNumber(summary, 'lastRunDurationMs'),
    ...optionalNullableNumber(summary, 'lastRunExitCode'),
    ...optionalBoolean(summary, 'lastRunTimedOut'),
    ...optionalString(summary, 'lastError'),
  };
}

function boundChatSummaryCache(cache: ChatSummaryCache): ChatSummaryCache {
  const ordered = [...cache.entries].sort((left, right) =>
    right.summary.updatedAt.localeCompare(left.summary.updatedAt),
  );
  const entries: ChatSummaryCacheEntry[] = [];
  const emptyCache = { ...cache, entries: [] };
  let cacheBytes = new TextEncoder().encode(JSON.stringify(emptyCache)).length;
  for (const entry of ordered) {
    if (entries.length >= CHAT_SUMMARY_CACHE_MAX_ENTRIES) {
      break;
    }
    const clonedEntry = {
      summary: cloneChatSummary(entry.summary),
      cachedAt: entry.cachedAt,
    };
    const entryBytes = new TextEncoder().encode(JSON.stringify(clonedEntry)).length;
    const separatorBytes = entries.length > 0 ? 1 : 0;
    if (cacheBytes + separatorBytes + entryBytes > CHAT_SUMMARY_CACHE_MAX_BYTES) {
      continue;
    }
    entries.push(clonedEntry);
    cacheBytes += separatorBytes + entryBytes;
  }
  return { ...cache, entries };
}

async function readCache(path: string, profileId: string): Promise<ChatSummaryCache> {
  try {
    return parseChatSummaryCache(await FileSystem.readAsStringAsync(path), profileId);
  } catch {
    return createEmptyChatSummaryCache(profileId);
  }
}

async function writeCache(path: string, cache: ChatSummaryCache): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystem.writeAsStringAsync(path, JSON.stringify(cache));
}

function enqueue(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = operationChains.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operationChains.set(path, next);
  return next.finally(() => {
    if (operationChains.get(path) === next) {
      operationChains.delete(path);
    }
  });
}

function shouldReplaceSummary(existing: ChatSummary, incoming: ChatSummary): boolean {
  const updatedAtDiff = incoming.updatedAt.localeCompare(existing.updatedAt);
  return (
    updatedAtDiff > 0 ||
    (updatedAtDiff === 0 && incoming.statusUpdatedAt.localeCompare(existing.statusUpdatedAt) >= 0)
  );
}

function normalizeTimestamp(value: unknown, fallback: number): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : new Date(fallback).toISOString();
}

function normalizeNullableTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isChatStatus(value: unknown): value is ChatSummary['status'] {
  return value === 'idle' || value === 'running' || value === 'error' || value === 'complete';
}

function optionalString<K extends keyof ChatSummary>(
  source: Record<string, unknown>,
  key: K,
): Partial<Pick<ChatSummary, K>> {
  return typeof source[key] === 'string'
    ? ({ [key]: source[key] } as Partial<Pick<ChatSummary, K>>)
    : {};
}

function optionalNullableString<K extends keyof ChatSummary>(
  source: Record<string, unknown>,
  key: K,
): Partial<Pick<ChatSummary, K>> {
  return typeof source[key] === 'string' || source[key] === null
    ? ({ [key]: source[key] } as Partial<Pick<ChatSummary, K>>)
    : {};
}

function optionalNumber<K extends keyof ChatSummary>(
  source: Record<string, unknown>,
  key: K,
): Partial<Pick<ChatSummary, K>> {
  return typeof source[key] === 'number' && Number.isFinite(source[key])
    ? ({ [key]: source[key] } as Partial<Pick<ChatSummary, K>>)
    : {};
}

function optionalNullableNumber<K extends keyof ChatSummary>(
  source: Record<string, unknown>,
  key: K,
): Partial<Pick<ChatSummary, K>> {
  return (typeof source[key] === 'number' && Number.isFinite(source[key])) || source[key] === null
    ? ({ [key]: source[key] } as Partial<Pick<ChatSummary, K>>)
    : {};
}

function optionalBoolean<K extends keyof ChatSummary>(
  source: Record<string, unknown>,
  key: K,
): Partial<Pick<ChatSummary, K>> {
  return typeof source[key] === 'boolean'
    ? ({ [key]: source[key] } as Partial<Pick<ChatSummary, K>>)
    : {};
}
