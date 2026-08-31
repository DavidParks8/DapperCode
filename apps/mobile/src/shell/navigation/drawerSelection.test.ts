import type { ChatSummary } from '@bridge/types/types';
import type { DrawerAttentionRow, DrawerAttentionSection } from '@shell/navigation/drawerAttention';
import {
  areAllChatIdsSelected,
  collectSelectableChatIds,
  describeBulkDeleteFailure,
  describeBulkDeletion,
  formatBulkDeleteLabel,
  formatSelectionSummary,
  formatSelectionTitle,
  pruneSelectedChatIds,
  resolveBulkDeleteRootIds,
  toggleSelectedChatId,
} from '@shell/navigation/drawerSelection';

function createChat(id: string, parentThreadId?: string): ChatSummary {
  return {
    id,
    title: `Chat ${id}`,
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    cwd: '/workspace',
    lastMessagePreview: '',
    ...(parentThreadId ? { parentThreadId } : null),
  };
}

function createRow(id: string): DrawerAttentionRow {
  return {
    chat: createChat(id),
    lane: 'recent',
    attentionReason: null,
    stateLabel: 'Idle',
    agentLabel: 'Codex',
    workspaceKey: '/workspace',
    workspaceLabel: 'workspace',
    indentLevel: 0,
  };
}

function createSection(
  key: 'attention' | 'working' | 'recent',
  ids: string[],
): DrawerAttentionSection {
  return {
    key,
    title: key,
    itemCount: ids.length,
    data: ids.map(createRow),
  };
}

describe('collectSelectableChatIds', () => {
  it('lists rendered chat ids in visual order without duplicates', () => {
    const sections = [createSection('attention', ['a', 'b']), createSection('recent', ['b', 'c'])];

    expect(collectSelectableChatIds(sections)).toEqual(['a', 'b', 'c']);
  });

  it('ignores collapsed lanes that render no rows', () => {
    const sections = [createSection('attention', ['a']), createSection('recent', [])];

    expect(collectSelectableChatIds(sections)).toEqual(['a']);
  });
});

describe('toggleSelectedChatId', () => {
  it('adds an unselected id and removes a selected one', () => {
    const added = toggleSelectedChatId(new Set(['a']), 'b');
    expect(Array.from(added)).toEqual(['a', 'b']);

    const removed = toggleSelectedChatId(added, 'a');
    expect(Array.from(removed)).toEqual(['b']);
  });
});

describe('pruneSelectedChatIds', () => {
  it('drops ids the drawer no longer lists', () => {
    const pruned = pruneSelectedChatIds(new Set(['a', 'b']), ['b', 'c']);

    expect(Array.from(pruned)).toEqual(['b']);
  });

  it('returns the same set when every id survives so the drawer does not re-render', () => {
    const selected = new Set(['a', 'b']);

    expect(pruneSelectedChatIds(selected, ['a', 'b', 'c'])).toBe(selected);
  });
});

describe('areAllChatIdsSelected', () => {
  it('reports true only when every listed id is selected', () => {
    expect(areAllChatIdsSelected(['a', 'b'], new Set(['a', 'b']))).toBe(true);
    expect(areAllChatIdsSelected(['a', 'b'], new Set(['a']))).toBe(false);
  });

  it('reports false for an empty list so "Deselect All" never shows with nothing listed', () => {
    expect(areAllChatIdsSelected([], new Set())).toBe(false);
  });
});

describe('resolveBulkDeleteRootIds', () => {
  it('keeps every independently selected session', () => {
    const chats = [createChat('a'), createChat('b'), createChat('c')];

    expect(resolveBulkDeleteRootIds(chats, new Set(['a', 'c']))).toEqual(['a', 'c']);
  });

  it('drops a selected descendant because deleting its selected ancestor already removes it', () => {
    const chats = [createChat('a'), createChat('b', 'a'), createChat('c', 'b'), createChat('d')];

    expect(resolveBulkDeleteRootIds(chats, new Set(['a', 'b', 'c', 'd']))).toEqual(['a', 'd']);
  });

  it('keeps a selected descendant whose ancestor is not selected', () => {
    const chats = [createChat('a'), createChat('b', 'a')];

    expect(resolveBulkDeleteRootIds(chats, new Set(['b']))).toEqual(['b']);
  });

  it('ignores selected ids the chat list no longer contains', () => {
    const chats = [createChat('a')];

    expect(resolveBulkDeleteRootIds(chats, new Set(['a', 'missing']))).toEqual(['a']);
  });

  it('survives a parent cycle without hanging', () => {
    const chats = [createChat('a', 'b'), createChat('b', 'a')];

    expect(resolveBulkDeleteRootIds(chats, new Set(['a']))).toEqual(['a']);
  });
});

describe('selection copy', () => {
  it('titles the header by selection count', () => {
    expect(formatSelectionTitle(0)).toBe('Select Sessions');
    expect(formatSelectionTitle(1)).toBe('1 Selected');
    expect(formatSelectionTitle(4)).toBe('4 Selected');
  });

  it('summarizes the selection for the live region', () => {
    expect(formatSelectionSummary(0)).toBe('Tap sessions to select them');
    expect(formatSelectionSummary(1)).toBe('1 session selected');
    expect(formatSelectionSummary(3)).toBe('3 sessions selected');
  });

  it('labels the delete button with the count once something is selected', () => {
    expect(formatBulkDeleteLabel(0)).toBe('Delete');
    expect(formatBulkDeleteLabel(2)).toBe('Delete (2)');
  });

  it('describes the confirmation including linked sub-sessions', () => {
    expect(describeBulkDeletion(1, 0)).toEqual({
      title: 'Delete 1 session?',
      message: '1 selected session will be removed from this agent’s history.',
    });
    expect(describeBulkDeletion(3, 2)).toEqual({
      title: 'Delete 3 sessions?',
      message:
        '3 selected sessions and 2 linked sub-sessions will be removed from this agent’s history.',
    });
    expect(describeBulkDeletion(2, 1).message).toBe(
      '2 selected sessions and 1 linked sub-session will be removed from this agent’s history.',
    );
  });

  it('describes a partial bulk failure', () => {
    expect(describeBulkDeleteFailure(1)).toEqual({
      title: 'Could not delete 1 session',
      message: 'The session was restored. Check the bridge connection and try again.',
    });
    expect(describeBulkDeleteFailure(2)).toEqual({
      title: 'Could not delete 2 sessions',
      message: '2 sessions were restored. Check the bridge connection and try again.',
    });
  });
});
