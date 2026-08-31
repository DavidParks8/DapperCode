import type { ChatSummary } from '@bridge/types/types';
import type { DrawerAttentionSection } from '@shell/navigation/drawerAttention';

/** Chat ids currently rendered by the drawer list, in visual order. */
export function collectSelectableChatIds(sections: DrawerAttentionSection[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const row of section.data) {
      if (seen.has(row.chat.id)) {
        continue;
      }
      seen.add(row.chat.id);
      ids.push(row.chat.id);
    }
  }
  return ids;
}

export function toggleSelectedChatId(
  selectedChatIds: ReadonlySet<string>,
  chatId: string,
): ReadonlySet<string> {
  const next = new Set(selectedChatIds);
  if (!next.delete(chatId)) {
    next.add(chatId);
  }
  return next;
}

/**
 * Drops ids the drawer no longer lists so a session deleted by another client can never stay
 * silently selected and get counted by the delete button. Returns the original set when nothing
 * changed so the drawer does not re-render on every list refresh.
 */
export function pruneSelectedChatIds(
  selectedChatIds: ReadonlySet<string>,
  availableChatIds: Iterable<string>,
): ReadonlySet<string> {
  const available = availableChatIds instanceof Set ? availableChatIds : new Set(availableChatIds);
  const next = new Set<string>();
  for (const chatId of selectedChatIds) {
    if (available.has(chatId)) {
      next.add(chatId);
    }
  }
  return next.size === selectedChatIds.size ? selectedChatIds : next;
}

export function areAllChatIdsSelected(
  chatIds: readonly string[],
  selectedChatIds: ReadonlySet<string>,
): boolean {
  return chatIds.length > 0 && chatIds.every((chatId) => selectedChatIds.has(chatId));
}

/**
 * Topmost selected sessions. Deleting a parent already removes its descendants, so a selected
 * child whose ancestor is also selected must not be deleted a second time.
 */
export function resolveBulkDeleteRootIds(
  chats: ChatSummary[],
  selectedChatIds: ReadonlySet<string>,
): string[] {
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
  const rootIds: string[] = [];
  for (const chat of chats) {
    if (!selectedChatIds.has(chat.id)) {
      continue;
    }
    let parentId = chat.parentThreadId;
    let ancestorSelected = false;
    const visited = new Set<string>([chat.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (selectedChatIds.has(parentId)) {
        ancestorSelected = true;
        break;
      }
      parentId = chatsById.get(parentId)?.parentThreadId;
    }
    if (!ancestorSelected) {
      rootIds.push(chat.id);
    }
  }
  return rootIds;
}

export function formatSelectionTitle(selectedCount: number): string {
  return selectedCount === 0 ? 'Select Sessions' : `${String(selectedCount)} Selected`;
}

export function formatSelectionSummary(selectedCount: number): string {
  if (selectedCount === 0) {
    return 'Tap sessions to select them';
  }
  return `${String(selectedCount)} ${selectedCount === 1 ? 'session' : 'sessions'} selected`;
}

export function formatBulkDeleteLabel(selectedCount: number): string {
  return selectedCount === 0 ? 'Delete' : `Delete (${String(selectedCount)})`;
}

export function describeBulkDeletion(
  selectedCount: number,
  linkedCount: number,
): { title: string; message: string } {
  const subject = `${String(selectedCount)} selected ${selectedCount === 1 ? 'session' : 'sessions'}`;
  const linkedSuffix =
    linkedCount > 0
      ? ` and ${String(linkedCount)} linked sub-${linkedCount === 1 ? 'session' : 'sessions'}`
      : '';
  return {
    title: `Delete ${String(selectedCount)} ${selectedCount === 1 ? 'session' : 'sessions'}?`,
    message: `${subject}${linkedSuffix} will be removed from this agent’s history.`,
  };
}

export function describeBulkDeleteFailure(failedCount: number): { title: string; message: string } {
  return {
    title: `Could not delete ${String(failedCount)} ${failedCount === 1 ? 'session' : 'sessions'}`,
    message: `${
      failedCount === 1 ? 'The session was' : `${String(failedCount)} sessions were`
    } restored. Check the bridge connection and try again.`,
  };
}
