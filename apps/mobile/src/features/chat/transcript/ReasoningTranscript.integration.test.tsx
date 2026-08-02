import { EventType } from '@ag-ui/core';
import { FlatList } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { updateAgUiLiveAssistantMessages } from '@bridge/agui/agUi';
import type { Chat } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('@shared/testing/gestureHandlerMock'),
);

type Queryable = ReactTestInstance & {
  children: unknown[];
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

const theme = createAppTheme('dark');
const chat: Chat = {
  id: 'thread',
  title: 'Reasoning transcript',
  status: 'running',
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  statusUpdatedAt: '2026-08-02T00:00:00.000Z',
  lastMessagePreview: '',
  messages: [
    {
      id: 'reasoning',
      role: 'reasoning',
      content: 'Inspecting the active transcript',
      createdAt: '2026-08-02T00:00:01.000Z',
    },
  ],
};
const baseProps: ChatTranscriptViewProps = {
  chat,
  parentChat: null,
  bridgeUrl: 'https://bridge',
  bridgeToken: null,
  showToolCalls: true,
  agentThreadStatusById: new Map(),
  scrollRef: { current: null },
  inlineChoicesEnabled: false,
  onInlineOptionSelect: jest.fn(),
  onPinnedAutoScroll: jest.fn(),
  onJumpToLatest: jest.fn(),
  onScrollInteractionStart: jest.fn(),
  autoScrollStateRef: {
    current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
  },
  bottomInset: 0,
  scrollRailEnabled: false,
};

function renderTranscript(
  liveMessageState: ChatTranscriptViewProps['liveMessageState'],
): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} liveMessageState={liveMessageState} />
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected transcript tree');
  }
  return tree;
}

function updateTranscript(
  tree: ReactTestRenderer,
  liveMessageState: ChatTranscriptViewProps['liveMessageState'],
): void {
  act(() => {
    tree.update(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} liveMessageState={liveMessageState} />
      </AppThemeProvider>,
    );
  });
}

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.includes(text)).length > 0;
}

describe('reasoning transcript lifecycle', () => {
  it('shows a live preview, collapses on end, and expands on tap', () => {
    let state = updateAgUiLiveAssistantMessages(
      {},
      {
        threadId: chat.id,
        runId: 'run',
        event: {
          type: EventType.REASONING_MESSAGE_START,
          messageId: 'reasoning',
          role: 'reasoning',
        },
      },
    );
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: chat.id,
      runId: 'run',
      event: {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: 'reasoning',
        delta: 'Inspecting the active transcript',
      },
    });
    const tree = renderTranscript(state[chat.id]);
    const root = tree.root as Queryable;

    expect(hasText(root, 'Inspecting the active transcript')).toBe(true);

    state = updateAgUiLiveAssistantMessages(state, {
      threadId: chat.id,
      runId: 'run',
      event: { type: EventType.REASONING_MESSAGE_END, messageId: 'reasoning' },
    });
    updateTranscript(tree, state[chat.id]);

    expect(hasText(root, 'Inspecting the active transcript')).toBe(false);
    const control = root.findAll(
      (node) =>
        node.props['accessibilityLabel'] === 'Reasoning' &&
        typeof node.props['onPress'] === 'function',
    )[0];
    expect(control?.props['accessibilityState']).toEqual({ disabled: false, expanded: false });
    act(() => {
      (control?.props['onPress'] as (() => void) | undefined)?.();
    });
    expect(hasText(root, 'Inspecting the active transcript')).toBe(true);
    expect(root.findAllByType(FlatList)).toHaveLength(1);
    act(() => tree.unmount());
  });
});
