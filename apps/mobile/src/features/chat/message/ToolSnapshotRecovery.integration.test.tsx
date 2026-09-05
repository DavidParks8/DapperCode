import { act, render } from '@testing-library/react-native';
import { createStore, Provider, useAtomValue } from 'jotai';

import { applySnapshotToChat, type RawAcpSnapshot } from '@bridge/mapping/chatMapping';
import type { Chat } from '@bridge/types/types';
import { requireTestValue } from '@shared/testing/requireTestValue';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { resolveEquivalentChat } from '../state/chatReconciliation';
import { selectedChatAtom } from '../state/session';
import { ToolInvocationRow } from './ToolInvocation';
import { buildToolInvocations } from './toolInvocationModel';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const createdAt = '2026-09-04T00:00:00.000Z';
const theme = createAppTheme('dark');
const baseChat: Chat = {
  id: 'thread',
  title: 'Snapshot recovery',
  status: 'running',
  createdAt,
  updatedAt: createdAt,
  statusUpdatedAt: createdAt,
  lastMessagePreview: '',
  messages: [],
};

function snapshot(tool: Partial<RawAcpSnapshot['tools'][number]> = {}): RawAcpSnapshot {
  return {
    version: 2,
    messages: [
      { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Edit' }], truncated: false },
    ],
    tools: [
      {
        id: 'patch',
        kind: 'edit',
        status: 'in_progress',
        title: 'apply_patch',
        content: '',
        structuredContent: [{ type: 'diff', path: 'file.ts', oldText: 'before', newText: 'after' }],
        locations: [],
        truncated: false,
        subagent: false,
        ...tool,
      },
    ],
    plan: [],
    usage: {},
    config: [],
    commands: [],
    session: {
      agentId: 'codex',
      threadId: 'thread',
      updatedAt: createdAt,
      historyReconstruction: false,
    },
    active: { runId: 'run', sourceTurnId: 'turn', generation: 1, toolIds: ['patch'] },
  };
}

function SelectedToolRow() {
  const chat = requireTestValue(useAtomValue(selectedChatAtom) ?? undefined, 'selected chat');
  return (
    <ToolInvocationRow
      invocation={requireTestValue(buildToolInvocations(chat.messages)[0], 'tool invocation')}
      threadRunning={chat.status === 'running'}
    />
  );
}

function renderSnapshot(initial: RawAcpSnapshot) {
  const store = createStore();
  store.set(selectedChatAtom, applySnapshotToChat(baseChat, initial));
  const screen = render(
    <Provider store={store}>
      <AppThemeProvider theme={theme}>
        <SelectedToolRow />
      </AppThemeProvider>
    </Provider>,
  );
  const recover = (next: RawAcpSnapshot) => {
    const previous = requireTestValue(store.get(selectedChatAtom) ?? undefined, 'previous chat');
    const incoming = applySnapshotToChat(baseChat, next);
    expect(incoming.updatedAt).toBe(previous.updatedAt);
    expect(incoming.messages.map((message) => message.content)).toEqual(
      previous.messages.map((message) => message.content),
    );
    act(() => store.set(selectedChatAtom, resolveEquivalentChat(previous, incoming)));
    return requireTestValue(store.get(selectedChatAtom) ?? undefined, 'recovered chat');
  };
  return { screen, recover };
}

it.each(['completed', 'failed'] as const)(
  'settles a tool after %s snapshot recovery with unchanged text and session timestamps',
  (status) => {
    const { screen, recover } = renderSnapshot(snapshot());
    expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe(
      'Editing file.ts +1 -1',
    );
    expect(screen.getByTestId('tool-row').props['accessibilityValue']).toEqual({
      text: 'in progress',
    });
    expect(screen.getByTestId('tool-header-shimmer', { includeHiddenElements: true })).toBeTruthy();

    const recovered = recover(snapshot({ status }));
    expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe(
      status === 'completed' ? 'Edited file.ts +1 -1' : 'Failed to edit file.ts +1 -1',
    );
    expect(screen.getByTestId('tool-row').props['accessibilityValue']).toEqual({ text: status });
    expect(screen.queryByTestId('tool-header-shimmer', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByLabelText('file.ts, 1 line added, 1 line removed')).toBeTruthy();
    expect(buildToolInvocations(recovered.messages)[0]?.isError).toBe(status === 'failed');

    expect(recover(snapshot({ status }))).toBe(recovered);
    expect(screen.queryByTestId('tool-header-shimmer', { includeHiddenElements: true })).toBeNull();
  },
);

it('refreshes structured patch counts when the flattened snapshot output is identical', () => {
  const { screen, recover } = renderSnapshot(snapshot({ status: 'completed' }));
  expect(screen.getByLabelText('file.ts, 1 line added, 1 line removed')).toBeTruthy();

  const recovered = recover(
    snapshot({
      status: 'completed',
      structuredContent: [
        { type: 'diff', path: 'file.ts', oldText: null, newText: 'before\nafter' },
      ],
    }),
  );
  expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe('Edited file.ts +2');
  expect(screen.getByLabelText('file.ts, 2 lines added, 0 lines removed')).toBeTruthy();
  expect(screen.queryByLabelText('file.ts, 1 line added, 1 line removed')).toBeNull();
  expect(buildToolInvocations(recovered.messages)[0]?.diffs[0]).toMatchObject({
    oldText: null,
    newText: 'before\nafter',
  });
});
