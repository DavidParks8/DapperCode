import {
  mergeSnapshotPage,
  StaleSnapshotRevisionError,
  type HostBridgeApiClient,
  type SnapshotPageResponse,
} from '@bridge/client/client';
import { applySnapshotToChat } from '@bridge/mapping/chatMapping';
import type { Chat } from '@bridge/types/types';

export interface TranscriptContinuationState {
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  unavailableCount: number;
}

export type TranscriptContinuationResult =
  | { kind: 'page'; page: SnapshotPageResponse }
  | { kind: 'error'; error: string }
  | { kind: 'stale' }
  | { kind: 'noop' };

type SnapshotPageApi = Pick<HostBridgeApiClient, 'readSnapshotPage'>;

export function getTranscriptBeforeCursor(snapshot: Chat['acpSnapshot']): string | null {
  return (
    [snapshot?.messageCollection, snapshot?.reasoningCollection, snapshot?.toolCollection].find(
      (collection) => collection && collection.omittedCount > 0 && collection.beforeCursor,
    )?.beforeCursor ?? null
  );
}

export function getTranscriptContinuationState(chat: Chat): TranscriptContinuationState {
  const snapshot = chat.acpSnapshot;
  return {
    loading: false,
    error: null,
    exhausted: !getTranscriptBeforeCursor(snapshot),
    unavailableCount: snapshot?.continuation?.unavailableCount ?? 0,
  };
}

export function mergeTranscriptPage(chat: Chat, page: SnapshotPageResponse): Chat {
  const snapshot = chat.acpSnapshot;
  if (!snapshot) {
    return chat;
  }
  const sequences = new Set(snapshot.timeline?.map((entry) => entry.sequence));
  const mergedSnapshot = mergeSnapshotPage(snapshot, {
    ...page,
    // An overlapping history page is older than the live snapshot.
    entries: page.entries.filter((entry) => !sequences.has(entry.sequence)),
  });
  const mapped = applySnapshotToChat(chat, mergedSnapshot);
  const existingSnapshotMessageIds = new Set(
    applySnapshotToChat(chat, snapshot).messages.map((message) => message.id),
  );
  const truncationId = `${chat.id}::snapshot-truncated`;
  const messages = chat.messages.filter((message) => message.id !== truncationId);
  let insertionIndex = messages.length;
  for (const message of [...mapped.messages].reverse()) {
    const currentIndex = messages.findIndex((current) => current.id === message.id);
    if (currentIndex >= 0) {
      insertionIndex = currentIndex;
    } else if (!existingSnapshotMessageIds.has(message.id) || message.id === truncationId) {
      // Reconciliation may still be displaying an optimistic version of a newer canonical echo.
      // Only newly paged rows belong to this request; rehydrating the rest would duplicate it.
      messages.splice(insertionIndex, 0, message);
    }
  }
  // Pagination adds history, never replaces streamed content, optimistic turns, or runtime state.
  return { ...chat, messages, acpSnapshot: mergedSnapshot };
}

export class TranscriptContinuationController {
  constructor(private readonly api: SnapshotPageApi) {}

  async loadEarlier(chat: Chat): Promise<TranscriptContinuationResult> {
    const snapshot = chat.acpSnapshot;
    const revision = snapshot?.continuation?.revision;
    const beforeCursor = getTranscriptBeforeCursor(snapshot);
    if (!snapshot || revision === undefined || !beforeCursor) {
      return { kind: 'noop' };
    }

    try {
      const page = await this.api.readSnapshotPage({
        threadId: chat.id,
        beforeCursor,
        revision,
        limit: snapshot.continuation?.maxPageSize || 50,
      });
      return page.revision === revision ? { kind: 'page', page } : { kind: 'stale' };
    } catch (error) {
      if (error instanceof StaleSnapshotRevisionError) {
        return { kind: 'stale' };
      }
      return {
        kind: 'error',
        error: (error as Error).message || 'Unable to load earlier history',
      };
    }
  }
}
