import type { ChatSummary } from '../api/types';
import { DEFAULT_WORKSPACE_CHAT_LIMIT, type WorkspaceChatLimit } from '../appSettings';
import type { DrawerAttentionRow, DrawerAttentionSection } from './drawerAttention';

export function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function dedupeChatsById(chats: ChatSummary[]): ChatSummary[] {
  const byId = new Map<string, ChatSummary>();
  for (const chat of chats) {
    const existing = byId.get(chat.id);
    if (!existing || shouldReplaceChatSummary(existing, chat)) {
      byId.set(chat.id, chat);
    }
  }
  return Array.from(byId.values());
}

export function mergeDrawerChatBatch(
  previous: ChatSummary[],
  incoming: ChatSummary[],
): ChatSummary[] {
  if (previous.length === 0) {
    return sortChats(incoming);
  }
  const byId = new Map(previous.map((chat) => [chat.id, chat]));
  for (const chat of incoming) {
    const existing = byId.get(chat.id);
    if (!existing || shouldReplaceChatSummary(existing, chat)) {
      byId.set(chat.id, chat);
    }
  }
  return sortChats(Array.from(byId.values()));
}

function shouldReplaceChatSummary(existing: ChatSummary, incoming: ChatSummary): boolean {
  const updatedAtDiff = incoming.updatedAt.localeCompare(existing.updatedAt);
  if (updatedAtDiff !== 0) {
    return updatedAtDiff > 0;
  }
  return incoming.statusUpdatedAt.localeCompare(existing.statusUpdatedAt) >= 0;
}

export function areDrawerChatListsEquivalent(
  previous: ChatSummary[],
  next: ChatSummary[],
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }
  return previous.every((left, index) => {
    const right = next[index];
    return (
      left.id === right.id &&
      left.title === right.title &&
      left.status === right.status &&
      left.updatedAt === right.updatedAt &&
      left.lastMessagePreview === right.lastMessagePreview &&
      left.cwd === right.cwd &&
      left.agentId === right.agentId &&
      left.sourceKind === right.sourceKind &&
      left.parentThreadId === right.parentThreadId &&
      left.subAgentDepth === right.subAgentDepth &&
      left.lastError === right.lastError
    );
  });
}

export function relativeTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const weeks = Math.floor(days / 7);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (hours < 24) {
    return `${hours}h`;
  }
  if (days < 7) {
    return `${days}d`;
  }
  if (weeks < 5) {
    return `${weeks}w`;
  }
  return `${Math.floor(days / 30)}mo`;
}

export function formatCompactCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

export function normalizeWorkspaceChatLimit(value: WorkspaceChatLimit): WorkspaceChatLimit {
  return value === 10 || value === 25 || value === null ? value : DEFAULT_WORKSPACE_CHAT_LIMIT;
}

/**
 * Case-insensitive match across every field a person could plausibly search a session by:
 * its title, the workspace/folder it belongs to, the agent working it (by label or raw id),
 * and its current state label (e.g. "Approval requested", "Failed"). `query` must already be
 * trimmed and lower-cased by the caller so this stays a cheap, allocation-free comparison.
 */
export function matchesDrawerSearch(row: DrawerAttentionRow, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystacks: Array<string | null | undefined> = [
    row.chat.title,
    row.workspaceLabel,
    row.agentLabel,
    row.chat.agentId,
    row.stateLabel,
  ];
  return haystacks.some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(query),
  );
}

/**
 * Filters each lane's rows by `query` while preserving lane order and identity for lanes with
 * no matches (they are dropped entirely rather than rendered empty, matching how the unfiltered
 * model already omits empty lanes). `query` is trimmed/lower-cased internally so callers can pass
 * the raw search field value as-is.
 */
export function filterDrawerAttentionSections(
  sections: DrawerAttentionSection[],
  query: string,
): DrawerAttentionSection[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return sections;
  }
  return sections
    .map((section) => {
      const data = section.data.filter((row) => matchesDrawerSearch(row, normalized));
      return { ...section, data, itemCount: data.length };
    })
    .filter((section) => section.data.length > 0);
}
