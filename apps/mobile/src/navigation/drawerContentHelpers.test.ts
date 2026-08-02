import type { ChatSummary } from '../api/types';
import type { DrawerAttentionRow, DrawerAttentionSection } from './drawerAttention';
import {
  dedupeChatsById,
  filterDrawerAttentionSections,
  matchesDrawerSearch,
  mergeDrawerChatBatch,
} from './drawerContentHelpers';

function chat(title: string, updatedAt: string, statusUpdatedAt = updatedAt): ChatSummary {
  return {
    id: 'thread',
    title,
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt,
    statusUpdatedAt,
    lastMessagePreview: '',
  };
}

function row(overrides: Partial<DrawerAttentionRow> = {}): DrawerAttentionRow {
  return {
    chat: chat('Fix login bug', '2026-07-20T00:00:00.000Z'),
    lane: 'recent',
    attentionReason: null,
    stateLabel: 'Idle',
    agentLabel: 'Copilot',
    workspaceKey: 'alpha',
    workspaceLabel: 'alpha',
    indentLevel: 0,
    ...overrides,
  };
}

describe('drawer chat summary merging', () => {
  it('does not let a late stale batch overwrite a newer live summary', () => {
    const current = chat('New title', '2026-07-20T00:30:00.000Z');
    const stale = chat('Old title', '2026-07-20T00:20:00.000Z');

    expect(mergeDrawerChatBatch([current], [stale])).toEqual([current]);
    expect(dedupeChatsById([current, stale])).toEqual([current]);
  });

  it('uses status time to break equal update-time ties', () => {
    const current = chat('Old status', '2026-07-20T00:30:00.000Z', '2026-07-20T00:29:00.000Z');
    const incoming = chat('New status', '2026-07-20T00:30:00.000Z', '2026-07-20T00:30:00.000Z');

    expect(mergeDrawerChatBatch([current], [incoming])).toEqual([incoming]);
  });
});

describe('matchesDrawerSearch', () => {
  it('matches everything when the query is empty', () => {
    expect(matchesDrawerSearch(row(), '')).toBe(true);
  });

  it('matches case-insensitively against the title', () => {
    expect(matchesDrawerSearch(row({ chat: chat('Fix Login Bug', '2026-07-20T00:00:00.000Z') }), 'login')).toBe(
      true,
    );
  });

  it('matches against workspace/folder label', () => {
    expect(matchesDrawerSearch(row({ workspaceLabel: 'Beta Workspace' }), 'beta')).toBe(true);
  });

  it('matches against the agent label and the raw agent id', () => {
    const withAgent = row({
      agentLabel: 'Codex',
      chat: { ...row().chat, agentId: 'codex-cli' },
    });
    expect(matchesDrawerSearch(withAgent, 'codex')).toBe(true);
    expect(matchesDrawerSearch(withAgent, 'codex-cli')).toBe(true);
  });

  it('matches against meaningful status/context text', () => {
    expect(matchesDrawerSearch(row({ stateLabel: 'Approval requested' }), 'approval')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesDrawerSearch(row(), 'nonexistent')).toBe(false);
  });
});

describe('filterDrawerAttentionSections', () => {
  const sections: DrawerAttentionSection[] = [
    {
      key: 'attention',
      title: 'Needs your attention',
      itemCount: 1,
      data: [row({ chat: chat('Approval chat', '2026-07-20T00:00:00.000Z'), lane: 'attention' })],
    },
    {
      key: 'working',
      title: 'Working now',
      itemCount: 1,
      data: [row({ chat: chat('Working chat', '2026-07-20T00:00:00.000Z'), lane: 'working' })],
    },
    {
      key: 'recent',
      title: 'Recent',
      itemCount: 2,
      data: [
        row({ chat: chat('Recent chat alpha', '2026-07-20T00:00:00.000Z'), lane: 'recent' }),
        row({ chat: chat('Recent chat beta', '2026-07-20T00:00:00.000Z'), lane: 'recent' }),
      ],
    },
  ];

  it('returns sections unchanged when the query is blank', () => {
    expect(filterDrawerAttentionSections(sections, '   ')).toBe(sections);
  });

  it('preserves lane order and drops lanes with no matches', () => {
    const filtered = filterDrawerAttentionSections(sections, 'recent');
    expect(filtered.map((section) => section.key)).toEqual(['recent']);
    expect(filtered[0]?.data).toHaveLength(2);
  });

  it('keeps matches from multiple lanes in their original order', () => {
    const filtered = filterDrawerAttentionSections(sections, 'chat');
    expect(filtered.map((section) => section.key)).toEqual(['attention', 'working', 'recent']);
  });
});
