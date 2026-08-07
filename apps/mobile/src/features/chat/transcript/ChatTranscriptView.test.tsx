import { requireTestValue } from '@shared/testing/requireTestValue';
import * as Haptics from 'expo-haptics';
import { isValidElement } from 'react';
import { FlatList, Keyboard, Platform, Pressable, StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { Chat } from '@bridge/types/types';
import { createAgUiThreadMessageState } from '@bridge/agui/agUiMessages';
import { ChatScrollRail } from './scrollRail/ChatScrollRail';
import { JUMP_TO_LATEST_VISIBLE_SIZE } from './viewChrome';
import {
  CHAT_SCROLL_RAIL_ACTIVATION_DELAY_MS,
  CHAT_SCROLL_RAIL_TOUCH_WIDTH,
} from './scrollRail/geometry';
import { mockGestureByTestId, resetMockGestures } from '@shared/testing/gestureHandlerMock';
import { AppThemeProvider, createAppTheme, resolveMinimumTouchTarget } from '@shared/theme';
import {
  getRenderedGlassViewProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';
import {
  mockSharedValues,
  ReduceMotion,
  resetMockSharedValues,
  ZoomIn,
  ZoomOut,
} from '@shared/testing/reanimatedMock';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../message/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
  ToolInvocationRow: () => null,
}));

type Queryable = ReactTestInstance & {
  children: unknown[];
  props: Record<string, unknown> & {
    contentContainerStyle: unknown[];
    data: Array<Record<string, unknown>>;
    keyExtractor: (item: Record<string, unknown>) => string;
    onContentSizeChange: jest.Mock;
    onLayout: jest.Mock;
    onMomentumScrollBegin: jest.Mock;
    onMomentumScrollEnd: jest.Mock;
    onPress: jest.Mock;
    onScroll: jest.Mock;
    onScrollBeginDrag: jest.Mock;
    onScrollEndDrag: jest.Mock;
    onViewableItemsChanged: jest.Mock;
    renderItem: (info: Record<string, unknown>) => React.ReactElement;
  };
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByProps(props: Record<string, unknown>): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

type QueryableRenderer = ReactTestRenderer & { root: Queryable; toJSON(): unknown };

const theme = createAppTheme('dark');
const chat: Chat = {
  id: 'thread',
  title: 'Transcript',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'latest',
  messages: [
    { id: 'message', role: 'assistant', content: 'latest', createdAt: '2026-07-20T00:00:00.000Z' },
  ],
};

function makeMessages(count: number): Chat['messages'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${String(index)}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${String(index)}`,
    createdAt: `2026-07-20T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
  }));
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return { ...chat, ...overrides };
}

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
};

function render(overrides: Partial<ChatTranscriptViewProps> = {}): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} {...overrides} />
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected transcript tree');
  }
  return tree as QueryableRenderer;
}

function findText(root: Queryable, value: string): Queryable {
  const match = root.findAll((node) => node.children.includes(value))[0];
  if (!match) {
    throw new Error(`Missing text: ${value}`);
  }
  return match;
}

function getList(tree: ReactTestRenderer): Queryable {
  return tree.root.findByType(FlatList) as Queryable;
}

function scroll(list: Queryable, y: number, contentHeight = 1000, viewportHeight = 200): void {
  act(() =>
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 320, height: contentHeight },
        layoutMeasurement: { width: 320, height: viewportHeight },
      },
    }),
  );
}

function update(tree: ReactTestRenderer, overrides: Partial<ChatTranscriptViewProps>): void {
  act(() =>
    tree.update(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} {...overrides} />
      </AppThemeProvider>,
    ),
  );
}

describe('ChatTranscriptView activity event', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-05T12:00:05.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('advances the live duration without resetting on status copy and freezes on settlement', () => {
    const runningChat = makeChat({
      status: 'running',
      statusUpdatedAt: '2026-08-05T12:00:00.000Z',
      messages: [
        { id: 'user', role: 'user', content: 'work', createdAt: '2026-08-05T12:00:00.000Z' },
      ],
    });
    const tree = render({
      chat: runningChat,
      activity: { tone: 'running', title: 'Editing file', detail: 'src/main.ts' },
    });

    let header = getList(tree).props['ListHeaderComponent'] as React.ReactElement<{
      detail?: string;
      elapsedMs?: number;
      title: string;
      tone: string;
    }>;
    expect(header.props).toMatchObject({
      detail: 'src/main.ts',
      title: 'Editing file',
      tone: 'running',
      elapsedMs: 0,
    });

    act(() => jest.advanceTimersByTime(5_000));
    update(tree, {
      chat: runningChat,
      activity: { tone: 'running', title: 'Running tests' },
    });
    header = getList(tree).props['ListHeaderComponent'] as typeof header;
    expect(header.props).toMatchObject({ title: 'Running tests', elapsedMs: 5_000 });

    update(tree, {
      chat: {
        ...runningChat,
        status: 'complete',
        statusUpdatedAt: '2026-08-05T12:00:12.000Z',
      },
      activity: { tone: 'complete', title: 'Turn completed' },
    });
    header = getList(tree).props['ListHeaderComponent'] as typeof header;
    expect(header.props).toMatchObject({
      title: 'Turn completed',
      tone: 'complete',
      elapsedMs: 5_000,
    });

    act(() => jest.advanceTimersByTime(5_000));
    header = getList(tree).props['ListHeaderComponent'] as typeof header;
    expect(header.props.elapsedMs).toBe(5_000);

    update(tree, { activity: null });
    expect(getList(tree).props['ListHeaderComponent']).toBeNull();
    act(() => tree.unmount());
  });
});

describe('ChatTranscriptView edge scrims', () => {
  it('fades transcript content only into the bottom chrome without blocking touches', () => {
    const tree = render({ topInset: 96, bottomInset: 88 });
    const bottomScrim = requireTestValue(
      tree.root.findAllByProps({ testID: 'transcript-bottom-scrim' })[0],
      'bottom transcript scrim',
    );

    // A scrim under the glass top chrome muddied the material and made the oldest message read
    // as clipped, so the top boundary is now handled by the glass plane alone.
    expect(tree.root.findAllByProps({ testID: 'transcript-top-scrim' })).toHaveLength(0);
    expect(bottomScrim.props['pointerEvents']).toBe('none');
    // A stop that reaches full opacity before the composer would park its glass on flat black,
    // so the bottom scrim ramps continuously across the whole composer band instead.
    expect(bottomScrim.props['colors']).toEqual([theme.colors.transparent, theme.colors.bgMain]);
    expect(bottomScrim.props['locations']).toBeUndefined();
    expect(StyleSheet.flatten(bottomScrim.props['style'] as never)).toMatchObject({
      position: 'absolute',
      bottom: 0,
      height: 88 + theme.spacing.xxl,
      zIndex: 1,
    });
    act(() => tree.unmount());
  });
});

describe('ChatTranscriptView conversation fork action', () => {
  it('gates authoritative boundaries and locks duplicate activation until settlement', async () => {
    let resolveFork: (() => void) | undefined;
    const onForkConversation = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFork = resolve;
        }),
    );
    const messages: Chat['messages'] = [
      { id: 'user-1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'assistant-1', role: 'assistant', content: 'Done', createdAt: '2026-08-01T00:00:01Z' },
      { id: 'user-2', role: 'user', content: 'Second', createdAt: '2026-08-01T00:00:02Z' },
      { id: 'assistant-2', role: 'assistant', content: 'Done', createdAt: '2026-08-01T00:00:03Z' },
      { id: 'msg-local', role: 'user', content: 'Pending', createdAt: '2026-08-01T00:00:04Z' },
    ];
    const tree = render({
      chat: makeChat({ messages }),
      supportsConversationFork: true,
      onForkConversation,
    });
    const list = getList(tree);
    const actionMessage = list.props.data.find(
      (item) =>
        item['kind'] === 'message' &&
        (item['message'] as { id?: string } | undefined)?.id === 'assistant-1',
    );
    if (!actionMessage) {
      throw new Error('Expected response carrying the fork action');
    }
    const rendered = list.props.renderItem({
      item: actionMessage,
      index: 0,
      separators: {},
    }) as React.ReactElement<{
      children: React.ReactNode[];
    }>;
    const reveal = rendered.props.children[0];
    if (
      !isValidElement<{
        children: React.ReactElement<{ onForkConversation?: () => void; forkBusy: boolean }>;
      }>(reveal)
    ) {
      throw new Error('Expected timestamp reveal around the response');
    }
    const response = reveal.props.children;
    if (!response?.props.onForkConversation) {
      throw new Error('Expected fork action beside the response actions');
    }
    expect(response.props.forkBusy).toBe(false);

    act(() => {
      response.props.onForkConversation?.();
      response.props.onForkConversation?.();
    });
    expect(onForkConversation).toHaveBeenCalledTimes(1);
    expect(onForkConversation).toHaveBeenCalledWith('assistant-1');

    await act(async () => {
      resolveFork?.();
      await Promise.resolve();
    });
    act(() => tree.unmount());
  });

  it('offers the newest response its own boundary when the bridge resolves responses', async () => {
    const onForkConversation = jest.fn().mockResolvedValue(undefined);
    const messages: Chat['messages'] = [
      { id: 'user-1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'assistant-1', role: 'assistant', content: 'Done', createdAt: '2026-08-01T00:00:01Z' },
    ];
    const tree = render({
      chat: makeChat({ messages }),
      supportsConversationFork: true,
      onForkConversation,
    });
    const list = getList(tree);
    const actionMessage = list.props.data.find(
      (item) =>
        item['kind'] === 'message' &&
        (item['message'] as { id?: string } | undefined)?.id === 'assistant-1',
    );
    if (!actionMessage) {
      throw new Error('Expected the newest response to carry the fork action');
    }
    const rendered = list.props.renderItem({
      item: actionMessage,
      index: 0,
      separators: {},
    }) as React.ReactElement<{ children: React.ReactNode[] }>;
    const reveal = rendered.props.children[0];
    if (
      !isValidElement<{
        children: React.ReactElement<{ onForkConversation?: () => void }>;
      }>(reveal)
    ) {
      throw new Error('Expected timestamp reveal around the response');
    }
    const response = reveal.props.children;
    if (!response?.props.onForkConversation) {
      throw new Error('Expected the newest response to expose the fork action');
    }

    await act(async () => {
      response.props.onForkConversation?.();
      await Promise.resolve();
    });
    expect(onForkConversation).toHaveBeenCalledWith('assistant-1');
    act(() => tree.unmount());
  });

  it('does not render fork actions when the selected agent lacks fork support', () => {
    const tree = render({
      chat: makeChat({
        messages: [
          { id: 'user-1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-08-01T00:00:01Z',
          },
          { id: 'user-2', role: 'user', content: 'Second', createdAt: '2026-08-01T00:00:02Z' },
          {
            id: 'assistant-2',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-08-01T00:00:03Z',
          },
        ],
      }),
      supportsConversationFork: false,
      onForkConversation: jest.fn(),
    });
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Fork conversation from here' }),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('does not offer fork actions on inherited sub-agent history', () => {
    const tree = render({
      chat: makeChat({
        parentThreadId: 'parent',
        messages: [
          { id: 'user-1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-08-01T00:00:01Z',
          },
          { id: 'user-2', role: 'user', content: 'Second', createdAt: '2026-08-01T00:00:02Z' },
          {
            id: 'assistant-2',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-08-01T00:00:03Z',
          },
        ],
      }),
      supportsConversationFork: true,
      onForkConversation: jest.fn().mockResolvedValue(undefined),
    });
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Fork conversation from here' }),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('does not offer fork actions when complete fork history is unavailable', () => {
    const tree = render({
      chat: makeChat({
        messages: [
          { id: 'user-1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-08-01T00:00:01Z',
          },
          { id: 'user-2', role: 'user', content: 'Second', createdAt: '2026-08-01T00:00:02Z' },
          {
            id: 'assistant-2',
            role: 'assistant',
            content: 'Done',
            createdAt: '2026-08-01T00:00:03Z',
          },
        ],
      }),
      continuationState: { loading: false, error: null, exhausted: true, unavailableCount: 1 },
      supportsConversationFork: true,
      onForkConversation: jest.fn().mockResolvedValue(undefined),
    });
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Fork conversation from here' }),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });
});

describe('ChatTranscriptView message timestamp reveal', () => {
  beforeEach(() => {
    resetMockGestures();
    resetMockSharedValues();
  });

  it('reveals timestamps only for user messages and settled assistant responses', () => {
    const tree = render({
      chat: makeChat({
        messages: [
          {
            id: 'user',
            role: 'user',
            content: 'Question',
            createdAt: '2026-07-20T19:42:00.000Z',
          },
          {
            id: 'assistant',
            role: 'assistant',
            content: 'Answer',
            createdAt: '2026-07-20T19:42:01.000Z',
            completedAt: '2026-07-20T19:42:08.000Z',
          },
          {
            id: 'pending',
            role: 'assistant',
            content: 'Still printing',
            createdAt: '2026-07-20T19:42:09.000Z',
            pending: true,
          },
          {
            id: 'reasoning',
            role: 'reasoning',
            content: 'Thinking',
            createdAt: '2026-07-20T19:42:10.000Z',
          },
          {
            id: 'tool',
            role: 'tool',
            toolCallId: 'tool',
            content: 'Tool output',
            createdAt: '2026-07-20T19:42:11.000Z',
          },
        ],
      }),
    });

    expect(
      tree.root.findAllByProps({ testID: 'message-timestamp-reveal-user' }).length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAllByProps({ testID: 'message-timestamp-reveal-assistant' }).length,
    ).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'message-timestamp-reveal-pending' })).toHaveLength(
      0,
    );
    expect(tree.root.findAllByProps({ testID: 'message-timestamp-reveal-reasoning' })).toHaveLength(
      0,
    );
    expect(tree.root.findAllByProps({ testID: 'message-timestamp-reveal-tool' })).toHaveLength(0);

    const gesture = mockGestureByTestId('message-timestamp-reveal-pan');
    expect(gesture.config['activeOffsetX']).toBe(-10);
    expect(gesture.config['failOffsetY']).toEqual([-12, 12]);
    act(() => gesture.onUpdate?.({ translationX: -200 }));
    expect(mockSharedValues.some((value) => value.value === -72)).toBe(true);
    act(() => gesture.onFinalize?.({ translationX: -200 }));
    expect(mockSharedValues.every((value) => value.value !== -72)).toBe(true);

    act(() => tree.unmount());
  });
});

describe('ChatTranscriptView magical scroll rail', () => {
  beforeEach(() => {
    resetMockGestures();
    jest.mocked(Haptics.impactAsync).mockClear();
    jest.mocked(Haptics.selectionAsync).mockClear();
  });

  it('renders one fixed-pitch bar per user message and configures delayed edge activation', () => {
    const messages: Chat['messages'] = [
      { id: 'u1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'approval', role: 'system', content: 'Approved', createdAt: '2026-08-01T00:00:01Z' },
      { id: 'a1', role: 'assistant', content: 'Reply', createdAt: '2026-08-01T00:00:02Z' },
      { id: 'u2', role: 'user', content: 'Second', createdAt: '2026-08-01T00:00:03Z' },
    ];
    const tree = render({ chat: makeChat({ messages }) });
    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 300 } } }));

    expect(tree.root.findAllByProps({ testID: 'chat-scroll-rail-bar-u1' }).length).toBeGreaterThan(
      0,
    );
    expect(tree.root.findAllByProps({ testID: 'chat-scroll-rail-bar-u2' }).length).toBeGreaterThan(
      0,
    );
    expect(tree.root.findAllByProps({ testID: 'chat-scroll-rail-bar-approval' })).toHaveLength(0);
    const gesture = mockGestureByTestId('chat-scroll-rail-pan');
    expect(gesture.config['hitSlop']).toEqual({ width: CHAT_SCROLL_RAIL_TOUCH_WIDTH, right: 0 });
    expect(gesture.config['activateAfterLongPress']).toBe(CHAT_SCROLL_RAIL_ACTIVATION_DELAY_MS);
    expect(gesture.config['maxPointers']).toBe(1);
    act(() => tree.unmount());
  });

  it('suppresses pinned scrolling, jumps without animation, haptically ticks, and restores release state', () => {
    const messages: Chat['messages'] = [
      { id: 'u1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'Reply', createdAt: '2026-08-01T00:00:01Z' },
      { id: 'u2', role: 'user', content: 'Second', createdAt: '2026-08-01T00:00:02Z' },
    ];
    const scrollToIndex = jest.fn();
    const scrollToOffset = jest.fn();
    const scrollRef = {
      current: null,
    } as React.RefObject<FlatList<never> | null>;
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: true },
    };
    const onScrollInteractionStart = jest.fn();
    const onPinnedAutoScroll = jest.fn();
    const tree = render({
      chat: makeChat({ messages }),
      scrollRef: scrollRef as ChatTranscriptViewProps['scrollRef'],
      autoScrollStateRef,
      onScrollInteractionStart,
      onPinnedAutoScroll,
    });
    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 300 } } }));
    scrollRef.current = { scrollToIndex, scrollToOffset } as unknown as FlatList<never>;
    const gesture = mockGestureByTestId('chat-scroll-rail-pan');

    act(() => {
      gesture.onStart?.({ y: 136 });
    });
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(onScrollInteractionStart).toHaveBeenCalledTimes(1);
    expect(autoScrollStateRef.current).toEqual({
      shouldStickToBottom: false,
      isUserInteracting: true,
      isMomentumScrolling: false,
    });
    expect(getList(tree).props['scrollEnabled']).toBe(false);
    expect(scrollToIndex).toHaveBeenLastCalledWith({
      index: expect.any(Number),
      animated: false,
      viewPosition: 1,
      viewOffset: -theme.spacing.lg,
    });

    act(() => {
      gesture.onUpdate?.({ y: 164 });
      getList(tree).props.onContentSizeChange(320, 1200);
    });
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(autoScrollStateRef.current.shouldStickToBottom).toBe(false);
    expect(autoScrollStateRef.current.isUserInteracting).toBe(true);
    expect(onPinnedAutoScroll).toHaveBeenCalledWith(false);

    act(() => {
      gesture.onFinalize?.({ y: 164 });
    });
    expect(getList(tree).props['scrollEnabled']).toBe(true);
    expect(autoScrollStateRef.current.isUserInteracting).toBe(false);
    const settledJumpCount = scrollToIndex.mock.calls.length;
    update(tree, {
      chat: makeChat({
        messages: [
          ...messages,
          {
            id: 'stream-update',
            role: 'assistant',
            content: 'More',
            createdAt: '2026-08-01T00:00:03Z',
          },
        ],
      }),
      scrollRef: scrollRef as ChatTranscriptViewProps['scrollRef'],
      autoScrollStateRef,
      onScrollInteractionStart,
      onPinnedAutoScroll,
    });
    expect(scrollToIndex).toHaveBeenCalledTimes(settledJumpCount);
    act(() => tree.unmount());
  });

  it('keeps the collapsed rail visible only on wide viewports', () => {
    const shared = { value: 0 };
    const anchors = [{ messageId: 'u1', transcriptIndex: 0 }];
    let phoneTree: ReactTestRenderer | undefined;
    act(() => {
      phoneTree = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatScrollRail
            anchors={anchors}
            activeIndex={0}
            windowStart={0}
            capacity={8}
            viewportHeight={300}
            topInset={0}
            alwaysVisible={false}
            engaged={shared as never}
            fingerY={shared as never}
          />
        </AppThemeProvider>,
      );
    });
    const phoneRail = (phoneTree as QueryableRenderer).root.findByProps({
      testID: 'chat-scroll-rail',
    }) as Queryable;
    expect((phoneRail.props['style'] as Array<{ opacity?: number }>)[1]?.opacity).toBe(0);
    act(() => phoneTree?.unmount());

    let tabletTree: ReactTestRenderer | undefined;
    act(() => {
      tabletTree = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatScrollRail
            anchors={anchors}
            activeIndex={0}
            windowStart={0}
            capacity={8}
            viewportHeight={500}
            topInset={0}
            alwaysVisible
            engaged={shared as never}
            fingerY={shared as never}
          />
        </AppThemeProvider>,
      );
    });
    const tabletRail = (tabletTree as QueryableRenderer).root.findByProps({
      testID: 'chat-scroll-rail',
    }) as Queryable;
    expect((tabletRail.props['style'] as Array<{ opacity?: number }>)[1]?.opacity).toBe(1);
    act(() => tabletTree?.unmount());
  });

  it('ignores a finalized edge gesture that never reached its long-press start', () => {
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    };
    const tree = render({
      chat: makeChat({ messages: makeMessages(4) }),
      autoScrollStateRef,
    });
    const gesture = mockGestureByTestId('chat-scroll-rail-pan');
    act(() => gesture.onFinalize?.({ y: 120 }));
    expect(autoScrollStateRef.current).toEqual({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
    act(() => tree.unmount());
  });

  it('does not engage the rail when the transcript has no user messages', () => {
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    };
    const onScrollInteractionStart = jest.fn();
    const tree = render({ autoScrollStateRef, onScrollInteractionStart });
    const gesture = mockGestureByTestId('chat-scroll-rail-pan');
    act(() => gesture.onStart?.({ y: 120 }));

    expect(getList(tree).props['scrollEnabled']).toBe(true);
    expect(onScrollInteractionStart).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('cancels an engaged rail when the chat changes', () => {
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    };
    const tree = render({
      chat: makeChat({ id: 'first', messages: makeMessages(6) }),
      autoScrollStateRef,
    });
    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 300 } } }));
    const gesture = mockGestureByTestId('chat-scroll-rail-pan');
    act(() => gesture.onStart?.({ y: 140 }));
    expect(getList(tree).props['scrollEnabled']).toBe(false);

    update(tree, {
      chat: makeChat({ id: 'second', messages: makeMessages(4) }),
      autoScrollStateRef,
    });
    expect(getList(tree).props['scrollEnabled']).toBe(true);
    expect(autoScrollStateRef.current.isUserInteracting).toBe(false);
    act(() => tree.unmount());
  });

  it('re-centers the rail on the current position when chats switch with equal anchor counts', () => {
    const scrollToIndex = jest.fn();
    const scrollRef = {
      current: null,
    } as React.RefObject<FlatList<never> | null>;
    const first = makeChat({ id: 'first-long', messages: makeMessages(80) });
    const second = makeChat({ id: 'second-long', messages: makeMessages(80) });
    const tree = render({
      chat: first,
      scrollRef: scrollRef as ChatTranscriptViewProps['scrollRef'],
    });
    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 300 } } }));

    update(tree, {
      chat: second,
      scrollRef: scrollRef as ChatTranscriptViewProps['scrollRef'],
    });
    scrollRef.current = {
      scrollToIndex,
      scrollToOffset: jest.fn(),
    } as unknown as FlatList<never>;
    const gesture = mockGestureByTestId('chat-scroll-rail-pan');
    act(() => gesture.onStart?.({ y: 148 }));

    expect(scrollToIndex).toHaveBeenCalledWith({
      index: expect.any(Number),
      animated: false,
      viewPosition: 1,
      viewOffset: -theme.spacing.lg,
    });
    expect((scrollToIndex.mock.calls[0]?.[0] as { index: number }).index).toBeLessThan(20);
    act(() => gesture.onFinalize?.({ y: 148 }));
    act(() => tree.unmount());
  });

  it('tracks the visual top with viewport coverage viewability', () => {
    const scrollToIndex = jest.fn();
    const scrollRef = {
      current: null,
    } as React.RefObject<FlatList<never> | null>;
    const tree = render({
      chat: makeChat({ messages: makeMessages(80) }),
      scrollRef: scrollRef as ChatTranscriptViewProps['scrollRef'],
    });
    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 300 } } }));
    let list = getList(tree);
    expect(list.props['viewabilityConfig']).toEqual({ viewAreaCoveragePercentThreshold: 1 });
    const oldestDisplayItem = list.props.data[79];
    act(() =>
      list.props.onViewableItemsChanged({
        viewableItems: [
          {
            index: 79,
            item: oldestDisplayItem,
            key: 'oldest',
            isViewable: true,
          },
        ],
        changed: [],
      }),
    );

    list = getList(tree);
    scrollRef.current = {
      scrollToIndex,
      scrollToOffset: jest.fn(),
    } as unknown as FlatList<never>;
    const gesture = mockGestureByTestId('chat-scroll-rail-pan');
    act(() => gesture.onStart?.({ y: 28 }));
    expect((scrollToIndex.mock.calls[0]?.[0] as { index: number }).index).toBeGreaterThan(60);
    act(() => gesture.onFinalize?.({ y: 28 }));
    act(() => tree.unmount());
  });
});

describe('ChatTranscriptView continuation', () => {
  it('top-aligns short transcripts in the inverted list', () => {
    const tree = render();
    const list = getList(tree);

    expect(list.props['inverted']).toBe(true);
    expect(StyleSheet.flatten(list.props.contentContainerStyle as never)).toMatchObject({
      flexGrow: 1,
      justifyContent: 'flex-end',
    });

    act(() => tree.unmount());
  });

  it('renders load, loading, retry, exhausted, and unavailable boundary states', () => {
    const onLoadEarlier = jest.fn();
    const tree = render({
      continuationState: { loading: false, error: null, exhausted: false, unavailableCount: 0 },
      onLoadEarlier,
    });
    const list = tree.root.findByType(FlatList);
    expect(list.props['inverted']).toBe(true);
    expect(list.props['maintainVisibleContentPosition']).toEqual({ minIndexForVisible: 0 });
    const loadBoundary = list.props['ListFooterComponent'] as React.ReactElement<{
      onPress: () => void;
    }>;
    act(() => loadBoundary.props.onPress());
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    act(() =>
      tree.update(
        <AppThemeProvider theme={theme}>
          <ChatTranscriptView
            {...baseProps}
            onLoadEarlier={onLoadEarlier}
            continuationState={{
              loading: true,
              error: null,
              exhausted: false,
              unavailableCount: 0,
            }}
          />
        </AppThemeProvider>,
      ),
    );
    expect(findText(tree.root, 'Loading earlier history...')).toBeTruthy();

    act(() =>
      tree.update(
        <AppThemeProvider theme={theme}>
          <ChatTranscriptView
            {...baseProps}
            onLoadEarlier={onLoadEarlier}
            continuationState={{
              loading: false,
              error: 'offline',
              exhausted: false,
              unavailableCount: 0,
            }}
          />
        </AppThemeProvider>,
      ),
    );
    expect(findText(tree.root, 'Earlier history failed to load. Tap to retry.')).toBeTruthy();

    act(() =>
      tree.update(
        <AppThemeProvider theme={theme}>
          <ChatTranscriptView
            {...baseProps}
            onLoadEarlier={onLoadEarlier}
            continuationState={{
              loading: false,
              error: null,
              exhausted: true,
              unavailableCount: 0,
            }}
          />
        </AppThemeProvider>,
      ),
    );
    expect(
      tree.root.findAll((node) => node.children.includes('Beginning of history')),
    ).toHaveLength(0);

    act(() =>
      tree.update(
        <AppThemeProvider theme={theme}>
          <ChatTranscriptView
            {...baseProps}
            onLoadEarlier={onLoadEarlier}
            continuationState={{
              loading: false,
              error: null,
              exhausted: true,
              unavailableCount: 3,
            }}
          />
        </AppThemeProvider>,
      ),
    );
    expect(findText(tree.root, '3 older history entries are no longer available.')).toBeTruthy();

    update(tree, {
      continuationState: { loading: false, error: null, exhausted: true, unavailableCount: 1 },
      onLoadEarlier,
    });
    expect(findText(tree.root, '1 older history entry is no longer available.')).toBeTruthy();
    act(() => tree.unmount());
  });

  it('drives drag, momentum, near-bottom, away-bottom, and jump-latest callbacks', () => {
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    };
    const onScrollInteractionStart = jest.fn();
    const onJumpToLatest = jest.fn();
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(jest.fn());
    const tree = render({ autoScrollStateRef, onScrollInteractionStart, onJumpToLatest });
    let list = getList(tree);

    act(() => list.props.onScrollBeginDrag());
    expect(onScrollInteractionStart).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(autoScrollStateRef.current).toEqual({
      shouldStickToBottom: false,
      isUserInteracting: true,
      isMomentumScrolling: false,
    });

    act(() => list.props.onMomentumScrollBegin());
    act(() => list.props.onScrollEndDrag());
    expect(autoScrollStateRef.current.isUserInteracting).toBe(true);
    act(() => list.props.onMomentumScrollEnd());
    expect(autoScrollStateRef.current.isUserInteracting).toBe(false);
    expect(autoScrollStateRef.current.isMomentumScrolling).toBe(false);

    act(() => list.props.onScrollBeginDrag());
    act(() => list.props.onScrollEndDrag());
    expect(autoScrollStateRef.current.isUserInteracting).toBe(false);

    scroll(list, 100);
    expect(autoScrollStateRef.current.shouldStickToBottom).toBe(false);
    const jump = tree.root.findByProps({
      accessibilityLabel: 'Jump to latest message',
    }) as Queryable;
    act(() => jump.props.onPress());
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    expect(autoScrollStateRef.current.shouldStickToBottom).toBe(true);

    list = getList(tree);
    scroll(list, -10);
    expect(autoScrollStateRef.current.shouldStickToBottom).toBe(true);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Jump to latest message' })).toHaveLength(
      0,
    );
    dismiss.mockRestore();
    act(() => tree.unmount());
  });

  it('keeps the jump-to-latest control hidden when the transcript is not scrollable', () => {
    const tree = render({});
    const list = getList(tree);

    scroll(list, 120, 240, 240);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Jump to latest message' })).toHaveLength(
      0,
    );
    act(() => tree.unmount());
  });

  it('hides the jump-to-latest control once the remaining content fits the viewport', () => {
    const tree = render({});
    let list = getList(tree);

    scroll(list, 120, 1000, 200);
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Jump to latest message' }).length,
    ).toBeGreaterThan(0);

    list = getList(tree);
    act(() => list.props.onContentSizeChange(320, 200));
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Jump to latest message' })).toHaveLength(
      0,
    );
    act(() => tree.unmount());
  });

  it('renders the jump-to-latest button as a 48pt circular toolbar target', () => {
    const tree = render({});
    const list = getList(tree);
    scroll(list, 100);

    const jump = tree.root.findByProps({
      accessibilityLabel: 'Jump to latest message',
    }) as Queryable;
    const hitSlop = jump.props['hitSlop'] as
      { top: number; bottom: number; left: number; right: number } | undefined;
    const glassSurface = tree.root.findByProps({ testID: 'jump-to-latest-glass-surface' });
    const glassStyle = StyleSheet.flatten(glassSurface.props['style'] as never) as Record<
      string,
      unknown
    >;
    expect(hitSlop).toBeDefined();
    expect(JUMP_TO_LATEST_VISIBLE_SIZE).toEqual({ width: 48, height: 48 });
    expect(
      jump.findAll((node) => node.props['testID'] === 'jump-to-latest-glass-surface'),
    ).not.toHaveLength(0);
    expect(glassStyle['width']).toBe(48);
    expect(glassStyle['height']).toBe(48);
    expect(JUMP_TO_LATEST_VISIBLE_SIZE.width).toBeGreaterThanOrEqual(resolveMinimumTouchTarget());
    expect(JUMP_TO_LATEST_VISIBLE_SIZE.height).toBeGreaterThanOrEqual(resolveMinimumTouchTarget());
    act(() => tree.unmount());
  });

  it('renders jump-to-latest with Liquid Glass without fading or native size compression', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);
    const tree = render({});
    scroll(getList(tree), 100);

    const glassProps = getRenderedGlassViewProps().find(
      (props) => props.testID === 'jump-to-latest-glass-surface',
    );
    expect(glassProps?.glassEffectStyle).toBe(theme.glass.capsule.glassEffectStyle);
    expect(glassProps?.isInteractive).toBe(false);

    act(() => tree.unmount());
  });

  it('wires transform-only jump-to-latest transitions to honor system Reduce Motion', () => {
    const enterSpy = jest.spyOn(ZoomIn, 'reduceMotion');
    const exitSpy = jest.spyOn(ZoomOut, 'reduceMotion');
    const tree = render({});
    const list = getList(tree);
    scroll(list, 100);

    expect(enterSpy).toHaveBeenCalledWith(ReduceMotion.System);
    expect(exitSpy).toHaveBeenCalledWith(ReduceMotion.System);

    enterSpy.mockRestore();
    exitSpy.mockRestore();
    act(() => tree.unmount());
  });

  it('loads local pages from layout, content changes, and older-directed scrolls once per checkpoint', () => {
    const largeChat = makeChat({ messages: makeMessages(140) });
    const onPinnedAutoScroll = jest.fn();
    const tree = render({ chat: largeChat, onPinnedAutoScroll });
    let list = getList(tree);
    expect(list.props.data).toHaveLength(80);
    expect(list.props['initialNumToRender']).toBe(18);
    expect(list.props['maxToRenderPerBatch']).toBe(12);
    expect(list.props['updateCellsBatchingPeriod']).toBe(32);
    expect(list.props['windowSize']).toBe(13);

    act(() => list.props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    list = getList(tree);
    expect(list.props.data).toHaveLength(140);

    act(() => list.props.onContentSizeChange(320, 1000));
    expect(onPinnedAutoScroll).toHaveBeenCalledWith(false);
    scroll(list, 100, 1000, 200);
    expect(getList(tree).props.data).toHaveLength(140);

    const pagedChat = makeChat({ id: 'paged', messages: makeMessages(220) });
    update(tree, { chat: pagedChat, onPinnedAutoScroll });
    list = getList(tree);
    expect(list.props.data).toHaveLength(80);
    act(() => list.props.onContentSizeChange(320, 1000));
    scroll(list, 100, 1000, 0);
    scroll(list, 100, 1000, 200);
    scroll(list, 101, 1000, 200);
    scroll(list, 100, 1000, 200);
    expect(getList(tree).props.data).toHaveLength(80);
    const checkpointScroll = getList(tree).props.onScroll;
    act(() => {
      checkpointScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 760 },
          contentSize: { width: 320, height: 1000 },
          layoutMeasurement: { width: 320, height: 200 },
        },
      });
      checkpointScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 780 },
          contentSize: { width: 320, height: 1000 },
          layoutMeasurement: { width: 320, height: 200 },
        },
      });
    });
    expect(getList(tree).props.data).toHaveLength(160);
    scroll(getList(tree), 700, 1000, 200);
    scroll(getList(tree), 790, 1000, 200);
    expect(getList(tree).props.data).toHaveLength(220);

    update(tree, {
      chat: makeChat({ id: 'shrunk', messages: makeMessages(180) }),
      onPinnedAutoScroll,
    });
    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    expect(getList(tree).props.data).toHaveLength(160);
    update(tree, {
      chat: makeChat({ id: 'shrunk', messages: makeMessages(20) }),
      onPinnedAutoScroll,
    });
    expect(getList(tree).props.data).toHaveLength(20);
    act(() => tree.unmount());
  });

  it('guards bridge pagination while loading or exhausted and requests it when available', () => {
    const onLoadEarlier = jest.fn();
    const tree = render({
      continuationState: { loading: true, error: null, exhausted: false, unavailableCount: 0 },
      onLoadEarlier,
    });
    let list = getList(tree);
    act(() => list.props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    expect(onLoadEarlier).not.toHaveBeenCalled();

    update(tree, {
      continuationState: { loading: false, error: null, exhausted: true, unavailableCount: 0 },
      onLoadEarlier,
    });
    list = getList(tree);
    act(() => list.props.onContentSizeChange(320, 100));
    expect(onLoadEarlier).not.toHaveBeenCalled();

    update(tree, {
      continuationState: { loading: false, error: null, exhausted: false, unavailableCount: 0 },
      onLoadEarlier,
    });
    list = getList(tree);
    act(() => list.props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    update(tree, { continuationState: undefined, onLoadEarlier });
    list = getList(tree);
    act(() => list.props.onContentSizeChange(320, 100));
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('uses platform keyboard behavior and inverted-aware insets', () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const androidTree = render({ bottomInset: 24, topInset: 40 });
    const androidList = getList(androidTree);
    expect(androidList.props['keyboardDismissMode']).toBe('on-drag');
    expect(androidList.props.contentContainerStyle[1]).toEqual({
      paddingTop: 24,
      paddingBottom: 40 + theme.spacing.lg,
    });
    act(() => androidTree.unmount());

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const iosTree = render({ bottomInset: 12, topInset: 40 });
    const iosList = getList(iosTree);
    expect(iosList.props['keyboardDismissMode']).toBe('interactive');
    // The list renders inverted, so the visual top is fed by `paddingBottom`. iOS once mapped
    // these the other way round, which clipped the oldest message under the floating chrome and
    // left a chrome-sized gap above the composer.
    expect(iosList.props['inverted']).toBe(true);
    expect(iosList.props.contentContainerStyle[1]).toEqual({
      paddingTop: 12,
      paddingBottom: 40 + theme.spacing.lg,
    });
    act(() => iosTree.unmount());
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  });

  it('applies a measured top inset after the memoized transcript has mounted', () => {
    const tree = render({ topInset: 24 });
    expect(getList(tree).props.contentContainerStyle[1]).toEqual({
      paddingTop: 0,
      paddingBottom: 24 + theme.spacing.lg,
    });

    update(tree, { topInset: 64 });

    expect(getList(tree).props.contentContainerStyle[1]).toEqual({
      paddingTop: 0,
      paddingBottom: 64 + theme.spacing.lg,
    });
    act(() => tree.unmount());
  });

  it('resets paging and scroll state for a new chat id', () => {
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    };
    const first = makeChat({ id: 'first', messages: makeMessages(180) });
    const tree = render({ chat: first, autoScrollStateRef });
    scroll(getList(tree), 100);
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Jump to latest message' }).length,
    ).toBeGreaterThan(0);

    const second = makeChat({ id: 'second', title: '', messages: makeMessages(20) });
    update(tree, { chat: second, autoScrollStateRef });
    const list = getList(tree);
    expect(list.props.data).toHaveLength(20);
    expect(list.props['accessibilityLabel']).toBe('Chat transcript');
    expect(tree.root.findAllByType(Pressable)).toHaveLength(0);
    expect(autoScrollStateRef.current).toEqual({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
    act(() => tree.unmount());
  });

  /**
   * Reproduces paged-in history vanishing when the thread keeps talking.
   *
   * Paging older messages in is a deliberate act by the reader. The reset that returns the
   * transcript to its newest page belongs to a chat switch, so it must not also run when a new
   * user message appears — that throws away everything the reader just paged in, mid-read.
   */
  it('keeps paged-in history when a new user message arrives in the same chat', () => {
    const paged = makeChat({ id: 'paged', messages: makeMessages(220) });
    const tree = render({ chat: paged });
    expect(getList(tree).props.data).toHaveLength(80);

    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    expect(getList(tree).props.data).toHaveLength(160);

    update(tree, { chat: makeChat({ id: 'paged', messages: makeMessages(221) }) });
    expect(getList(tree).props.data).toHaveLength(161);

    update(tree, { chat: makeChat({ id: 'other', messages: makeMessages(221) }) });
    expect(getList(tree).props.data).toHaveLength(80);
    act(() => tree.unmount());
  });

  it('memoizes equivalent chats and rerenders for every compared prop family', () => {
    const messages = makeMessages(2);
    const stableChat = makeChat({ messages });
    const equivalentTree = render({ chat: stableChat });
    const firstRenderItem = getList(equivalentTree).props.renderItem;
    update(equivalentTree, { chat: makeChat({ title: 'Ignored title change', messages }) });
    expect(getList(equivalentTree).props.renderItem).toBe(firstRenderItem);
    act(() => equivalentTree.unmount());

    const changedChats: Chat[] = [
      makeChat({ id: 'other', messages }),
      makeChat({ parentThreadId: 'parent', messages }),
      makeChat({ agentId: 'agent', messages }),
      makeChat({ status: 'running', messages }),
      makeChat({ messages: [...messages] }),
    ];
    for (const changedChat of changedChats) {
      const changedTree = render({ chat: stableChat });
      update(changedTree, { chat: changedChat });
      expect(getList(changedTree).props['extraData']).toEqual({
        liveMessageState: null,
        chatStatus: changedChat.status,
      });
      act(() => changedTree.unmount());
    }

    const parent = makeChat({ id: 'parent', messages });
    const parentTree = render({ chat: stableChat, parentChat: parent });
    update(parentTree, { chat: stableChat, parentChat: makeChat({ id: 'parent-2', messages }) });
    update(parentTree, { chat: stableChat, parentChat: null });
    act(() => parentTree.unmount());

    const propVariants: Partial<ChatTranscriptViewProps>[] = [
      { bridgeUrl: 'https://other' },
      { bridgeToken: 'token' },
      { onOpenLocalPreview: jest.fn() },
      { showToolCalls: false },
      { agentThreadStatusById: new Map([['thread', 'running']]) },
      { scrollRef: { current: null } },
      { inlineChoicesEnabled: true },
      { onInlineOptionSelect: jest.fn() },
      { onPinnedAutoScroll: jest.fn() },
      { onJumpToLatest: jest.fn() },
      { onScrollInteractionStart: jest.fn() },
      {
        autoScrollStateRef: {
          current: {
            shouldStickToBottom: true,
            isUserInteracting: false,
            isMomentumScrolling: false,
          },
        },
      },
      { bottomInset: 8 },
      { liveMessageState: createAgUiThreadMessageState() },
      { onOpenSubAgentThread: jest.fn() },
      { continuationState: { loading: false, error: null, exhausted: false, unavailableCount: 0 } },
      { onLoadEarlier: jest.fn() },
      { scrollRailEnabled: false },
    ];
    for (const variant of propVariants) {
      const variantTree = render({ chat: stableChat });
      update(variantTree, { chat: stableChat, ...variant });
      expect(getList(variantTree).props.data).toHaveLength(2);
      act(() => variantTree.unmount());
    }
  });

  it('renders and keys messages, tool groups, and inline options through FlatList callbacks', () => {
    const onInlineOptionSelect = jest.fn();
    const messages: Chat['messages'] = [
      {
        id: 'tool',
        role: 'tool',
        toolCallId: 'tool',
        content: '• Ran tests',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'choice',
        role: 'assistant',
        content: 'Which one?\n1. Fast - Quick result\n2. Safe',
        createdAt: '2026-07-20T00:00:01.000Z',
      },
    ];
    const tree = render({
      chat: makeChat({ status: 'running', messages }),
      inlineChoicesEnabled: true,
      onInlineOptionSelect,
    });
    const list = getList(tree);
    const messageItem = list.props.data.find((item) => item['kind'] === 'message');
    const toolItem = list.props.data.find((item) => item['kind'] === 'toolInvocation');
    if (!messageItem || !toolItem) {
      throw new Error('Expected message and tool items');
    }
    expect(list.props.keyExtractor(messageItem)).toBe(messageItem['renderKey']);
    expect(list.props.keyExtractor(toolItem)).toBe(toolItem['id']);

    const renderedMessage = list.props.renderItem({
      item: messageItem,
      index: 0,
      separators: {},
    }) as React.ReactElement<{ children: React.ReactNode[] }>;
    const inlineChoices = renderedMessage.props.children[1] as React.ReactElement<{
      children: React.ReactNode[];
    }>;
    const options = inlineChoices.props.children[0] as React.ReactElement<{
      accessibilityHint: string;
      onPress: () => void;
      style: (state: { pressed: boolean }) => unknown[];
    }>[];
    let toolTree: ReactTestRenderer | undefined;
    act(() => {
      toolTree = renderer.create(
        <AppThemeProvider theme={theme}>
          {list.props.renderItem({ item: toolItem, index: 1, separators: {} })}
        </AppThemeProvider>,
      );
    });
    if (!toolTree) {
      throw new Error('Expected rendered tool item');
    }
    expect(options).toHaveLength(2);
    expect(
      requireTestValue(options[0], 'indexed test value').props.style({ pressed: false })[1],
    ).toBe(false);
    expect(
      requireTestValue(options[0], 'indexed test value').props.style({ pressed: true })[1],
    ).toBeTruthy();
    expect(requireTestValue(options[1], 'indexed test value').props.accessibilityHint).toBe(
      'Fills the reply box with this answer',
    );
    act(() => requireTestValue(options[0], 'indexed test value').props.onPress());
    expect(onInlineOptionSelect).toHaveBeenCalledWith('Fast');
    expect((toolTree as QueryableRenderer).toJSON()).toBeTruthy();

    const noChoicesTree = render({
      chat: makeChat({ messages: [requireTestValue(messages[1], 'indexed test value')] }),
      inlineChoicesEnabled: false,
    });
    const noChoicesList = getList(noChoicesTree);
    let itemTree: ReactTestRenderer | undefined;
    act(() => {
      itemTree = renderer.create(
        <AppThemeProvider theme={theme}>
          {noChoicesList.props.renderItem({
            item: noChoicesList.props.data[0],
            index: 0,
            separators: {},
          })}
        </AppThemeProvider>,
      );
    });
    expect((itemTree as QueryableRenderer | undefined)?.root.findAllByType(Pressable)).toHaveLength(
      0,
    );
    act(() => {
      toolTree?.unmount();
      itemTree?.unmount();
      noChoicesTree.unmount();
      tree.unmount();
    });
  });

  it('renders a computer-use run as one grouped timeline', () => {
    const messages: Chat['messages'] = [
      {
        id: 'cu1',
        role: 'tool',
        toolCallId: 'cu1',
        content: '• Called tool `computeruse / screenshot`',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'cu2',
        role: 'tool',
        toolCallId: 'cu2',
        content: 'Window: Inbox, App: Safari',
        createdAt: '2026-07-20T00:00:01.000Z',
        toolMeta: {
          toolCallId: 'cu2',
          kind: 'other',
          status: 'completed',
          title: 'computeruse / click',
        },
      },
    ];
    const tree = render({ chat: makeChat({ messages }) });
    const groupItem = getList(tree).props.data.find((item) => item['kind'] === 'toolGroup');
    if (!groupItem) {
      throw new Error('Expected a computer-use tool group');
    }

    let groupTree: ReactTestRenderer | undefined;
    act(() => {
      groupTree = renderer.create(
        <AppThemeProvider theme={theme}>
          {getList(tree).props.renderItem({ item: groupItem, index: 0, separators: {} })}
        </AppThemeProvider>,
      );
    });
    const rendered = JSON.stringify((groupTree as QueryableRenderer | undefined)?.toJSON());
    // The bare metadata title still resolves, so both actions land in the same timeline.
    expect(rendered).toContain('Screenshot');
    expect(rendered).toContain('Click');
    expect(rendered).toContain('Safari');

    act(() => {
      groupTree?.unmount();
      tree.unmount();
    });
  });
});
