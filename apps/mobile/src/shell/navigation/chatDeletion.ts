import type { HostBridgeApiClient } from '@bridge/client/client';
import type { ChatSummary } from '@bridge/types/types';
import { resolveBulkDeleteRootIds } from '@shell/navigation/drawerSelection';

/**
 * Session deletion service. Every `deleteChat`/`forgetChat` call the drawer makes lives here so the
 * component layer only decides *when* to delete and how to report it, never how to talk to the
 * bridge.
 */
export type ChatDeletionApi = Pick<HostBridgeApiClient, 'deleteChat' | 'forgetChat'>;

/**
 * A root session plus every descendant the bridge removes along with it. `chats` holds the known
 * summaries (used to restore the rows on failure) while `chatIds` also covers a root that is no
 * longer in the loaded list.
 */
export type ChatDeletionFamily = {
  rootId: string;
  chats: ChatSummary[];
  chatIds: Set<string>;
};

/** Walks the parent/child links so deleting a session accounts for its whole sub-tree. */
export function buildChatDeletionFamily(chats: ChatSummary[], rootId: string): ChatDeletionFamily {
  const chatIds = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const chat of chats) {
      if (chat.parentThreadId && chatIds.has(chat.parentThreadId) && !chatIds.has(chat.id)) {
        chatIds.add(chat.id);
        changed = true;
      }
    }
  }
  return { rootId, chats: chats.filter((chat) => chatIds.has(chat.id)), chatIds };
}

/** Expands a selection into the exact set of sessions a bulk delete will remove. */
export function buildBulkDeletionPlan(
  chats: ChatSummary[],
  selectedChatIds: ReadonlySet<string>,
): { families: ChatDeletionFamily[]; affectedChatIds: Set<string> } {
  const families = resolveBulkDeleteRootIds(chats, selectedChatIds).map((rootId) =>
    buildChatDeletionFamily(chats, rootId),
  );
  const affectedChatIds = new Set<string>();
  for (const family of families) {
    for (const chatId of family.chatIds) {
      affectedChatIds.add(chatId);
    }
  }
  return { families, affectedChatIds };
}

/**
 * Deletes one family. Only the root is deleted on the bridge — descendants go away with it, so they
 * are merely forgotten locally. Returns the ids that were removed, or `null` when the bridge
 * refused and the caller must restore the rows.
 */
export async function deleteChatFamily(
  api: ChatDeletionApi,
  family: ChatDeletionFamily,
): Promise<Set<string> | null> {
  const deletedChatIds = new Set<string>();
  try {
    await api.deleteChat(family.rootId);
    deletedChatIds.add(family.rootId);
    for (const chatId of family.chatIds) {
      if (chatId !== family.rootId) {
        api.forgetChat(chatId);
        deletedChatIds.add(chatId);
      }
    }
  } catch {
    return null;
  }
  return deletedChatIds;
}

/**
 * Deletes families one at a time so a single refusal never cancels the rest of a bulk delete; the
 * caller restores exactly the families that failed.
 */
export async function deleteChatFamilies(
  api: ChatDeletionApi,
  families: ChatDeletionFamily[],
): Promise<{ failedFamilies: ChatDeletionFamily[]; deletedChatIds: Set<string> }> {
  const failedFamilies: ChatDeletionFamily[] = [];
  const deletedChatIds = new Set<string>();
  for (const family of families) {
    const deleted = await deleteChatFamily(api, family);
    if (!deleted) {
      failedFamilies.push(family);
      continue;
    }
    for (const chatId of deleted) {
      deletedChatIds.add(chatId);
    }
  }
  return { failedFamilies, deletedChatIds };
}

/** Puts optimistically removed rows back, reporting which ids returned to the list. */
export function restoreChatFamilies(
  families: ChatDeletionFamily[],
  restoreChat: (chat: ChatSummary) => void,
): Set<string> {
  const restoredChatIds = new Set<string>();
  for (const family of families) {
    for (const chat of family.chats) {
      restoreChat(chat);
      restoredChatIds.add(chat.id);
    }
  }
  return restoredChatIds;
}
