import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList } from 'react-native';

import type { Chat, ChatMessage } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';
import { ActivityEvent } from './ActivityEvent';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('@shared/testing/gestureHandlerMock'),
);

type Queryable = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByProps(props: Record<string, unknown>): Queryable[];
};

const theme = createAppTheme('dark');

function toolCall(id: string, title: string, status: 'in_progress' | 'completed'): ChatMessage {
  return {
    id,
    role: 'tool',
    toolCallId: id,
    content: status === 'completed' ? `${title} finished with a long settled result line` : '',
    createdAt: '2026-09-01T00:00:00.000Z',
    toolMeta: { toolCallId: id, kind: 'other', status, title },
  };
}

function makeChat(messages: ChatMessage[]): Chat {
  return {
    id: 'thread',
    title: 'Rapid tools',
    status: 'running',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    statusUpdatedAt: '2026-09-01T00:00:00.000Z',
    lastMessagePreview: '',
    messages,
  };
}

const baseProps: ChatTranscriptViewProps = {
  chat: makeChat([]),
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
  activity: { tone: 'running', title: 'Chasing the hamster' },
};

function element(messages: ChatMessage[], onPinnedAutoScroll = baseProps.onPinnedAutoScroll) {
  return (
    <AppThemeProvider theme={theme}>
      <ChatTranscriptView
        {...baseProps}
        chat={makeChat(messages)}
        onPinnedAutoScroll={onPinnedAutoScroll}
      />
    </AppThemeProvider>
  );
}

describe('tool rows adjacent to the transcript activity row', () => {
  /**
   * Fabric already keeps the visible content position of this inverted list. Asking the parent to
   * scroll to offset zero again on every content-size update creates a second position adjustment
   * on the same frames where rapid tool cells mount beside the activity header.
   */
  it('does not request redundant pinned scrolls while rapid tool rows insert at offset zero', () => {
    const onPinnedAutoScroll = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        element([toolCall('tool-1', 'Reading a file', 'in_progress')], onPinnedAutoScroll),
      );
    });
    if (!tree) {
      throw new Error('Expected a transcript tree');
    }
    const root = tree.root as Queryable;
    const list = () => root.findByType(FlatList) as Queryable;
    const notifyContentSizeChanged = () => {
      const handler = list().props['onContentSizeChange'] as (
        width: number,
        height: number,
      ) => void;
      handler(370, 600);
    };

    expect(list().props['ListHeaderComponent']).toBeDefined();
    expect(root.findAllByProps({ testID: 'tool-header-shimmer' })).toHaveLength(0);
    act(() => {
      const item = (list().props['data'] as unknown[])[0];
      const onViewableItemsChanged = list().props['onViewableItemsChanged'] as (event: {
        viewableItems: unknown[];
        changed: unknown[];
      }) => void;
      onViewableItemsChanged({
        viewableItems: [{ item, index: 0, key: 'tool-1', isViewable: true }],
        changed: [],
      });
    });
    expect(root.findAllByProps({ testID: 'tool-header-shimmer' }).length).toBeGreaterThan(0);
    act(notifyContentSizeChanged);
    expect(onPinnedAutoScroll).not.toHaveBeenCalled();

    // The first row settles and two more arrive in one burst; repeated size notifications at the
    // newest edge must not enqueue scroll retries against native maintain-visible positioning.
    act(() => {
      tree?.update(
        element(
          [
            toolCall('tool-1', 'Reading a file', 'completed'),
            toolCall('tool-2', 'Searching the workspace', 'completed'),
            toolCall('tool-3', 'Running the test suite', 'in_progress'),
          ],
          onPinnedAutoScroll,
        ),
      );
      notifyContentSizeChanged();
      notifyContentSizeChanged();
    });

    expect(onPinnedAutoScroll).not.toHaveBeenCalled();
    expect(root.findAllByProps({ testID: 'transcript-activity-event' })).not.toHaveLength(0);
    expect(root.findAllByProps({ testID: 'tool-row-layout' }).length).toBeGreaterThanOrEqual(3);

    // If the user is merely near the newest edge rather than exactly on it, retain the existing
    // correction so a growing row can finish pulling the transcript back to offset zero.
    act(() => {
      const onScroll = list().props['onScroll'] as (event: unknown) => void;
      onScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 10 },
          contentSize: { width: 370, height: 600 },
          layoutMeasurement: { width: 370, height: 500 },
        },
      });
      notifyContentSizeChanged();
    });
    expect(onPinnedAutoScroll).toHaveBeenCalledWith(false);

    act(() => {
      const currentList = list();
      const onScrollBeginDrag = currentList.props['onScrollBeginDrag'] as () => void;
      const onScroll = currentList.props['onScroll'] as (event: unknown) => void;
      const onScrollEndDrag = currentList.props['onScrollEndDrag'] as () => void;
      onScrollBeginDrag();
      onScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 100 },
          contentSize: { width: 370, height: 900 },
          layoutMeasurement: { width: 370, height: 500 },
        },
      });
      onScrollEndDrag();
    });
    expect(root.findByType(ActivityEvent).props['animationActive']).toBe(false);

    act(() => tree?.unmount());
  });
});
