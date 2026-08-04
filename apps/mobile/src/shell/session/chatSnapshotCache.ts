import * as FileSystem from 'expo-file-system/legacy';
import { MessageSchema } from '@ag-ui/core';

import type { Chat, ChatMessage, ChatMessagePart, ChatToolMeta } from '@bridge/types/types';

export const CHAT_SNAPSHOT_CACHE_VERSION = 1;
export const CHAT_SNAPSHOT_CACHE_MAX_ENTRIES = 20;
export const CHAT_SNAPSHOT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_SNAPSHOT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Inline image/audio/resource payloads and structured tool output are
 * transient (re-fetchable from the live session or bridge) and can dwarf
 * the rest of a chat's history. Anything larger than this is dropped from
 * the persisted snapshot so one oversized attachment can't crowd out - or
 * evict entirely - the rest of a chat's restorable history.
 */
export const CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES = 64 * 1024;

export interface ChatSnapshotCacheEntry {
  chat: Chat;
  cachedAt: string;
  lastAccessedAt: string;
}

export interface ChatSnapshotCache {
  version: 1;
  profileId: string;
  selectedChatId: string | null;
  updatedAt: string;
  entries: ChatSnapshotCacheEntry[];
}

const operationChains = new Map<string, Promise<void>>();
const purgeGenerations = new Map<string, number>();

export function getChatSnapshotCacheGeneration(profileId: string): number {
  return purgeGenerations.get(profileId) ?? 0;
}

function bumpChatSnapshotCacheGeneration(profileId: string): number {
  const next = getChatSnapshotCacheGeneration(profileId) + 1;
  purgeGenerations.set(profileId, next);
  return next;
}

function isChatSnapshotCacheGenerationCurrent(profileId: string, generation: number): boolean {
  return getChatSnapshotCacheGeneration(profileId) === generation;
}

export function createEmptyChatSnapshotCache(
  profileId: string,
  now = new Date().toISOString(),
): ChatSnapshotCache {
  return {
    version: CHAT_SNAPSHOT_CACHE_VERSION,
    profileId,
    selectedChatId: null,
    updatedAt: now,
    entries: [],
  };
}

export function parseChatSnapshotCache(
  raw: string,
  profileId: string,
  now = Date.now(),
): ChatSnapshotCache {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyChatSnapshotCache(profileId);
    }
    const record = parsed as Record<string, unknown>;
    if (
      record['version'] !== CHAT_SNAPSHOT_CACHE_VERSION ||
      record['profileId'] !== profileId ||
      !Array.isArray(record['entries'])
    ) {
      return createEmptyChatSnapshotCache(profileId);
    }

    const rawEntries: unknown[] = record['entries'];
    const entries = rawEntries
      .map(normalizeCacheEntry)
      .filter((entry): entry is ChatSnapshotCacheEntry => entry !== null)
      .filter((entry) => now - Date.parse(entry.cachedAt) <= CHAT_SNAPSHOT_CACHE_MAX_AGE_MS)
      .sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt));
    const selectedChatId =
      typeof record['selectedChatId'] === 'string' &&
      entries.some((entry) => entry.chat.id === record['selectedChatId'])
        ? record['selectedChatId']
        : null;

    return boundChatSnapshotCache({
      version: CHAT_SNAPSHOT_CACHE_VERSION,
      profileId,
      selectedChatId,
      updatedAt:
        typeof record['updatedAt'] === 'string' && Number.isFinite(Date.parse(record['updatedAt']))
          ? record['updatedAt']
          : new Date(now).toISOString(),
      entries,
    });
  } catch {
    return createEmptyChatSnapshotCache(profileId);
  }
}

export function updateChatSnapshotCache(
  cache: ChatSnapshotCache,
  selectedChatId: string | null,
  chat: Chat | null,
  now = new Date().toISOString(),
): ChatSnapshotCache {
  const normalizedSelectedChatId = selectedChatId?.trim() || null;
  // Untouched entries are carried over by reference: chat data flowing through
  // app state is always replaced wholesale (never mutated in place), so the
  // stored snapshot stays valid without a defensive deep clone of the whole
  // cache on every update.
  const entries = cache.entries.filter((entry) => entry.chat.id !== chat?.id);
  if (chat && isChat(chat)) {
    entries.unshift({
      chat: sanitizeChatForCache(chat),
      cachedAt: now,
      lastAccessedAt: now,
    });
  } else if (normalizedSelectedChatId) {
    const index = entries.findIndex((entry) => entry.chat.id === normalizedSelectedChatId);
    const entry = entries[index];
    if (entry) {
      entries[index] = { ...entry, lastAccessedAt: now };
    }
  }

  return boundChatSnapshotCache({
    version: CHAT_SNAPSHOT_CACHE_VERSION,
    profileId: cache.profileId,
    selectedChatId: normalizedSelectedChatId,
    updatedAt: now,
    entries,
  });
}

export async function loadChatSnapshotCache(profileId: string): Promise<ChatSnapshotCache> {
  const path = getChatSnapshotCachePath(profileId);
  if (!path) {
    return createEmptyChatSnapshotCache(profileId);
  }
  try {
    return parseChatSnapshotCache(await FileSystem.readAsStringAsync(path), profileId);
  } catch {
    return createEmptyChatSnapshotCache(profileId);
  }
}

export function saveChatSnapshotCache(
  cache: ChatSnapshotCache,
  generation = getChatSnapshotCacheGeneration(cache.profileId),
): Promise<void> {
  const path = getChatSnapshotCachePath(cache.profileId);
  if (!path) {
    return Promise.resolve();
  }

  return enqueueCacheOperation(path, async () => {
    if (!isChatSnapshotCacheGenerationCurrent(cache.profileId, generation)) {
      return;
    }

    const directory = path.slice(0, path.lastIndexOf('/') + 1);
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    // A purge can arrive while directory creation is pending. Re-check at
    // the final point before writing so this stale save cannot recreate it.
    if (!isChatSnapshotCacheGenerationCurrent(cache.profileId, generation)) {
      return;
    }
    await FileSystem.writeAsStringAsync(path, JSON.stringify(boundChatSnapshotCache(cache)));
  });
}

export function deleteChatSnapshotCache(profileId: string): Promise<void> {
  // Advance the barrier before enqueuing deletion so saves captured by a
  // pending debounce or an existing queue entry become stale immediately.
  bumpChatSnapshotCacheGeneration(profileId);
  const path = getChatSnapshotCachePath(profileId);
  if (!path) {
    return Promise.resolve();
  }
  return enqueueCacheOperation(path, async () => {
    try {
      await FileSystem.deleteAsync(path, { idempotent: true });
    } catch {
      // Cache cleanup is best effort.
    }
  });
}

export function getChatSnapshotCachePath(
  profileId: string,
  base = FileSystem.documentDirectory,
): string | null {
  if (typeof base !== 'string' || !base || !profileId.trim()) {
    return null;
  }
  return `${base}dappercode-chat-cache/${encodeURIComponent(profileId)}/snapshots.json`;
}

function enqueueCacheOperation(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = operationChains.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operationChains.set(path, next);
  return next.finally(() => {
    if (operationChains.get(path) === next) {
      operationChains.delete(path);
    }
  });
}

function boundChatSnapshotCache(cache: ChatSnapshotCache): ChatSnapshotCache {
  const ordered = [...cache.entries].sort((left, right) => {
    if (left.chat.id === cache.selectedChatId) {
      return -1;
    }
    if (right.chat.id === cache.selectedChatId) {
      return 1;
    }
    return right.lastAccessedAt.localeCompare(left.lastAccessedAt);
  });
  const entries: ChatSnapshotCacheEntry[] = [];
  // Track the accumulated byte size incrementally instead of re-serializing
  // the whole (ever-growing) candidate entries array on every iteration,
  // which turns bounding into O(n^2) work for large caches.
  let cacheBytes = utf8ByteLength(JSON.stringify({ ...cache, entries: [] }));
  for (const entry of ordered) {
    if (entries.length >= CHAT_SNAPSHOT_CACHE_MAX_ENTRIES) {
      break;
    }
    const entryBytes = utf8ByteLength(JSON.stringify(entry));
    const separatorBytes = entries.length > 0 ? 1 : 0;
    if (cacheBytes + separatorBytes + entryBytes > CHAT_SNAPSHOT_CACHE_MAX_BYTES) {
      continue;
    }
    entries.push(entry);
    cacheBytes += separatorBytes + entryBytes;
  }
  return {
    ...cache,
    selectedChatId: entries.some((entry) => entry.chat.id === cache.selectedChatId)
      ? cache.selectedChatId
      : null,
    entries,
  };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function normalizeCacheEntry(value: unknown): ChatSnapshotCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entry = value as Partial<ChatSnapshotCacheEntry>;
  if (
    !isChat(entry.chat) ||
    typeof entry.cachedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.cachedAt)) ||
    typeof entry.lastAccessedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.lastAccessedAt))
  ) {
    return null;
  }
  return {
    chat: sanitizeChatForCache(entry.chat),
    cachedAt: entry.cachedAt,
    lastAccessedAt: entry.lastAccessedAt,
  };
}

function isChat(value: unknown): value is Chat {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const chat = value as Partial<Chat>;
  return (
    typeof chat.id === 'string' &&
    chat.id.length > 0 &&
    typeof chat.title === 'string' &&
    typeof chat.status === 'string' &&
    typeof chat.createdAt === 'string' &&
    typeof chat.updatedAt === 'string' &&
    typeof chat.statusUpdatedAt === 'string' &&
    typeof chat.lastMessagePreview === 'string' &&
    Array.isArray(chat.messages) &&
    chat.messages.every(isChatMessage)
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    MessageSchema.safeParse(message).success &&
    typeof message['createdAt'] === 'string' &&
    (message['parts'] === undefined ||
      (Array.isArray(message['parts']) && message['parts'].every(isChatMessagePart)))
  );
}

function isChatMessagePart(value: unknown): value is ChatMessagePart {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const part = value as Record<string, unknown>;
  if (part['type'] === 'text') {
    return typeof part['text'] === 'string';
  }
  if (part['type'] === 'image' || part['type'] === 'audio') {
    return true;
  }
  if (part['type'] === 'resourceLink') {
    return typeof part['uri'] === 'string';
  }
  return (
    part['type'] === 'resource' &&
    typeof part['resource'] === 'object' &&
    part['resource'] !== null &&
    !Array.isArray(part['resource'])
  );
}

/**
 * Strips inline base64 media (`image`/`audio`/`resource` parts) and large
 * structured tool output from a chat before it's persisted to disk. This is
 * a privacy/performance trade-off: transient, cache-dominating payloads
 * (screenshots, file blobs, terminal dumps) are never written to the
 * snapshot cache, so one oversized attachment can't push the rest of a
 * chat's restorable history out of the byte budget - or, at the extreme,
 * get the whole chat entry dropped (see `boundChatSnapshotCache`).
 *
 * The live, in-memory chat object passed in is never mutated: when nothing
 * needs sanitizing (the common case) the original object is returned as-is
 * so no clone is paid for; otherwise only the messages/parts that changed
 * get new objects, everything else is structurally shared.
 */
function sanitizeChatForCache(chat: Chat): Chat {
  let changed = false;
  const messages = chat.messages.map((message) => {
    const sanitized = sanitizeMessageForCache(message);
    if (sanitized !== message) {
      changed = true;
    }
    return sanitized;
  });
  return changed ? { ...chat, messages } : chat;
}

function sanitizeMessageForCache(message: ChatMessage): ChatMessage {
  const parts = message.parts ? sanitizePartsForCache(message.parts) : message.parts;
  const toolMeta = message.toolMeta ? sanitizeToolMetaForCache(message.toolMeta) : message.toolMeta;
  if (parts === message.parts && toolMeta === message.toolMeta) {
    return message;
  }
  return { ...message, parts, toolMeta };
}

function sanitizePartsForCache(parts: ChatMessagePart[]): ChatMessagePart[] {
  let changed = false;
  const sanitized = parts.map((part) => {
    const next = sanitizePartForCache(part);
    if (next !== part) {
      changed = true;
    }
    return next;
  });
  return changed ? sanitized : parts;
}

function sanitizePartForCache(part: ChatMessagePart): ChatMessagePart {
  if ((part.type === 'image' || part.type === 'audio') && isOversizedPayload(part.data)) {
    const rest: Record<string, unknown> = { ...part };
    delete rest['data'];
    return rest as ChatMessagePart;
  }
  if (part.type === 'resource' && isOversizedPayload(part.resource.blob)) {
    const resource: Record<string, unknown> = { ...part.resource };
    delete resource['blob'];
    return { ...part, resource };
  }
  return part;
}

function sanitizeToolMetaForCache(toolMeta: ChatToolMeta): ChatToolMeta {
  const contentOversized =
    toolMeta.content !== undefined && isOversizedPayload(safeStringify(toolMeta.content));
  const locationsOversized =
    toolMeta.locations !== undefined && isOversizedPayload(safeStringify(toolMeta.locations));
  if (!contentOversized && !locationsOversized) {
    return toolMeta;
  }
  const next = { ...toolMeta };
  if (contentOversized) {
    delete next.content;
  }
  if (locationsOversized) {
    delete next.locations;
  }
  return next;
}

function isOversizedPayload(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > CHAT_SNAPSHOT_INLINE_PAYLOAD_MAX_BYTES;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
