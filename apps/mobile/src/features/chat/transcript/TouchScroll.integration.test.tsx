import { act, fireEvent, render } from '@testing-library/react-native';
import { createRef, isValidElement, type ReactElement, type ReactNode } from 'react';
import { ScrollView, type FlatList } from 'react-native';
import type * as ReactNative from 'react-native';
import { Provider } from 'jotai';

import type { Chat } from '@bridge/types/types';
import { HostBridgeWsClient } from '@bridge/ws/ws';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  useMainScreenLifecycleRecovery,
  type MainScreenLifecycleRecoveryResult,
} from '../session/lifecycleRecovery';
import { ChatTranscriptView } from './ChatTranscriptView';
import type { TranscriptDisplayItem } from './messages';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../message/ChatMessage', () => {
  const { Text } = jest.requireActual<typeof ReactNative>('react-native');
  return {
    ChatMessage: ({ message }: { message: { content: string } }) => <Text>{message.content}</Text>,
    ToolInvocationRow: () => null,
  };
});

const theme = createAppTheme('dark');
const runningChat = {
  id: 'touch-scroll',
  title: 'Touch scroll',
  status: 'running',
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
  statusUpdatedAt: '2026-09-16T00:00:00.000Z',
  lastMessagePreview: 'Streaming',
  messages: [
    {
      id: 'prompt',
      role: 'user',
      content: 'Keep this response anchored',
      createdAt: '2026-09-16T00:00:00.000Z',
    },
    {
      id: 'answer',
      role: 'assistant',
      content: 'Streaming',
      pending: true,
      createdAt: '2026-09-16T00:00:00.000Z',
    },
  ],
} satisfies Chat;

async function setup() {
  const scrollRef = createRef<FlatList<TranscriptDisplayItem>>();
  const recoveryRef = createRef<MainScreenLifecycleRecoveryResult>();
  const context: Parameters<typeof useMainScreenLifecycleRecovery>[0] = {
    foregroundAgentRefreshHandleRef: { current: null },
    genericRunningActivityTimeoutRef: { current: null },
    heldActivityTimeoutRef: { current: null },
    lastPinnedScrollAtRef: { current: 0 },
    scheduledPinnedScrollTimeoutRef: { current: null },
    scrollRetryTimeoutsRef: { current: [] },
    scrollRef,
    ws: new HostBridgeWsClient('http://localhost'),
  };
  function Harness({ chat }: { chat: Chat }) {
    const recovery = useMainScreenLifecycleRecovery(context);
    recoveryRef.current = recovery;
    return (
      <ChatTranscriptView
        chat={chat}
        parentChat={null}
        bridgeUrl="http://localhost"
        bridgeToken={null}
        showToolCalls
        agentThreadStatusById={new Map()}
        scrollRef={scrollRef}
        inlineChoicesEnabled={false}
        onInlineOptionSelect={() => {}}
        onPinnedAutoScroll={recovery.scrollToBottomIfPinned}
        onJumpToLatest={recovery.handleJumpToLatest}
        onScrollInteractionStart={recovery.clearPendingScrollRetries}
        autoScrollStateRef={recovery.autoScrollStateRef}
        bottomInset={88}
      />
    );
  }
  const element = (chat: Chat) => (
    <Provider>
      <AppThemeProvider theme={theme}>
        <Harness chat={chat} />
      </AppThemeProvider>
    </Provider>
  );
  const tree = await render(element(runningChat));
  if (!scrollRef.current || !recoveryRef.current) {
    throw new Error('Expected mounted transcript and scroll controller');
  }
  const recovery = recoveryRef.current;
  const scrollToOffset = jest
    .spyOn(scrollRef.current, 'scrollToOffset')
    .mockImplementation(() => {});
  const list = () =>
    tree.container.queryAll((node) => typeof node.props['onScroll'] === 'function')[0]!;
  const listProps = () => scrollRef.current!.props;
  const scroll = async (y: number, height = 1000) =>
    await fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 390, height },
        layoutMeasurement: { width: 390, height: 600 },
      },
    });
  return {
    tree,
    list,
    listProps,
    scroll,
    scrollRef,
    scrollToOffset,
    recovery,
    context,
    update: async (chat: Chat) => await tree.rerender(element(chat)),
  };
}

type ContentPosition = { minIndexForVisible: number } | null | undefined;
type NativeFrame = { key: string; y: number; height: number };
type NativeChild = ReactElement<{
  children?: ReactNode;
  collapsable?: boolean;
  item?: TranscriptDisplayItem;
  style?: unknown;
}>;

const CONTENT_INSET = 88;
const PROMPT_HEIGHT = 40;

function nativeChildren(node: ReactNode): NativeChild[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => nativeChildren(child));
  }
  return isValidElement<NativeChild['props']>(node) ? [node] : [];
}

/** Lays out the native scroll content: stacked cells plus the sentinel spanning all content. */
function measureNativeContent(app: Awaited<ReturnType<typeof setup>>, answerHeight: number) {
  const scrollView = app.list();
  const [content] = nativeChildren(scrollView.props['children'] as ReactNode);
  const children = nativeChildren(content?.props.children);
  let y = CONTENT_INSET;
  const frames = children.map((child): NativeFrame => {
    const item = child.props.item;
    const message = item?.kind === 'message' ? item.message : undefined;
    const height = message ? (message.id === 'answer' ? answerHeight : PROMPT_HEIGHT) : 0;
    y += height;
    return { key: child.key ?? 'sentinel', y: y - height, height };
  });
  for (const frame of frames) {
    if (frame.key === 'sentinel') {
      Object.assign(frame, { y: 0, height: y + CONTENT_INSET });
    }
  }
  return {
    children,
    frames,
    position: scrollView.props['maintainVisibleContentPosition'] as ContentPosition,
  };
}

/**
 * Mirrors RCTScrollViewComponentView's mounting observer: before each transaction it captures the
 * first visible content child under the previous props, and afterwards scrolls by how far that child
 * moved under the next props.
 */
function createNativeAnchoringModel(initialOffset: number) {
  let offset = initialOffset;
  let props: ContentPosition;
  let frames: NativeFrame[] = [];
  let anchor: NativeFrame | undefined;
  return {
    get offset() {
      return offset;
    },
    drag(to: number) {
      offset = to;
    },
    mount(next: ContentPosition, nextFrames: NativeFrame[]) {
      if (props) {
        const min = props.minIndexForVisible;
        anchor =
          frames.find(
            (frame, index) =>
              index >= min && (frame.y + frame.height > offset || index === frames.length - 1),
          ) ?? anchor;
      }
      props = next;
      frames = nextFrames;
      const moved = nextFrames.find((frame) => frame.key === anchor?.key);
      if (props && anchor && moved) {
        offset += moved.y - anchor.y;
      }
    },
  };
}

describe('streaming scroll ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('cancels an already queued animation frame when a stationary finger touches the transcript', async () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const app = await setup();
    await app.scroll(12);
    await act(() => {
      app.recovery.scrollToBottomIfPinned(false);
      jest.advanceTimersByTime(0);
    });
    expect(frames).toHaveLength(1);

    await fireEvent(app.list(), 'touchStart');
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    await act(() => frames[0]?.(0));
    await fireEvent(app.list(), 'contentSizeChange', 390, 1200);
    await act(() => jest.advanceTimersByTime(1000));
    expect(app.scrollToOffset).not.toHaveBeenCalled();

    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(false);
    await fireEvent(app.list(), 'contentSizeChange', 390, 1400);
    await act(() => jest.advanceTimersByTime(0));
    await act(() => frames.at(-1)?.(0));
    expect(app.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it('suppresses auto-scroll through streamed updates until the last finger lifts', async () => {
    const app = await setup();
    await fireEvent(app.list(), 'touchStart');
    await fireEvent(app.list(), 'scrollBeginDrag');
    await app.scroll(12);
    await fireEvent(app.list(), 'scrollEndDrag', { nativeEvent: { velocity: { x: 0, y: 0 } } });
    await fireEvent(app.list(), 'momentumScrollEnd');

    for (const height of [1100, 1200, 1300]) {
      await app.update({
        ...runningChat,
        messages: runningChat.messages.map((message) =>
          message.role === 'assistant'
            ? { ...message, content: `Streaming ${String(height)}` }
            : message,
        ),
      });
      expect(app.tree.getByText(`Streaming ${String(height)}`)).toBeTruthy();
      await fireEvent(app.list(), 'contentSizeChange', 390, height);
      await act(() => {
        app.recovery.schedulePinnedScrollToBottom();
        app.recovery.scrollToBottomReliable();
        jest.advanceTimersByTime(500);
      });
      expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
      expect(app.scrollToOffset).not.toHaveBeenCalled();
    }

    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [{ identifier: 1 }] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(false);
    await fireEvent(app.list(), 'contentSizeChange', 390, 1500);
    await act(() => jest.advanceTimersByTime(500));
    expect(app.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it('does not replay a cancelled frame after a history drag is released', async () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const app = await setup();
    await act(() => {
      app.recovery.scrollToBottomIfPinned(false);
      jest.advanceTimersByTime(0);
    });
    expect(frames).toHaveLength(1);
    await fireEvent(app.list(), 'touchStart');
    await fireEvent(app.list(), 'scrollBeginDrag');
    await app.scroll(160);
    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    await fireEvent(app.list(), 'scrollEndDrag', { nativeEvent: { velocity: { x: 0, y: 0 } } });
    await act(() => frames[0]?.(0));
    expect(app.scrollToOffset).not.toHaveBeenCalled();
    expect(app.tree.getByLabelText('Jump to latest message')).toBeTruthy();
    expect(app.recovery.autoScrollStateRef.current.shouldStickToBottom).toBe(false);
    await fireEvent.press(app.tree.getByLabelText('Jump to latest message'));
    await act(() => jest.advanceTimersByTime(0));
    await act(() => frames.at(-1)?.(0));
    expect(app.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
    expect(app.tree.queryByLabelText('Jump to latest message')).toBeNull();
  });

  it('rechecks pinned state when a throttled scroll becomes due', async () => {
    const app = await setup();
    app.context.lastPinnedScrollAtRef.current = Date.now();
    await act(() => app.recovery.schedulePinnedScrollToBottom(false));
    expect(app.context.scheduledPinnedScrollTimeoutRef.current).not.toBeNull();
    app.recovery.autoScrollStateRef.current.shouldStickToBottom = false;
    await act(() => jest.advanceTimersByTime(500));
    expect(app.scrollToOffset).not.toHaveBeenCalled();
  });

  it('preserves native drag ownership on touch cancellation and clears it after momentum', async () => {
    const app = await setup();
    await fireEvent(app.list(), 'touchStart');
    await fireEvent(app.list(), 'scrollBeginDrag');
    await fireEvent(app.list(), 'touchCancel', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    await app.scroll(160);
    await fireEvent(app.list(), 'scrollEndDrag', { nativeEvent: { velocity: { x: 0, y: 0 } } });
    await fireEvent(app.list(), 'momentumScrollBegin');
    await fireEvent(app.list(), 'contentSizeChange', 390, 1200);
    await act(() => jest.advanceTimersByTime(500));
    expect(app.scrollToOffset).not.toHaveBeenCalled();
    await fireEvent(app.list(), 'momentumScrollEnd');
    expect(app.recovery.autoScrollStateRef.current).toEqual({
      shouldStickToBottom: false,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
  });

  it('releases a cancelled touch that never became a drag and resets contact on chat navigation', async () => {
    const app = await setup();
    await fireEvent(app.list(), 'touchStart');
    await fireEvent(app.list(), 'touchCancel', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(false);
    expect(app.recovery.autoScrollStateRef.current.shouldStickToBottom).toBe(true);

    await fireEvent(app.list(), 'touchStart');
    await fireEvent(app.list(), 'scrollBeginDrag');
    await app.update({ ...runningChat, id: 'next-chat' });
    await fireEvent(app.list(), 'momentumScrollEnd');
    expect(app.recovery.autoScrollStateRef.current).toEqual({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
  });

  it('does not reconfigure native anchoring underneath a tap in a settled transcript', async () => {
    const app = await setup();
    await app.update({
      ...runningChat,
      status: 'complete',
      messages: runningChat.messages.map((message) =>
        message.role === 'assistant' ? { ...message, pending: false } : message,
      ),
    });
    await app.scroll(12);
    const anchoring = app.listProps().maintainVisibleContentPosition;
    expect(anchoring).toBeUndefined();
    await fireEvent(app.list(), 'touchStart');
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    expect(app.listProps().maintainVisibleContentPosition).toBe(anchoring);
    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    expect(app.listProps().maintainVisibleContentPosition).toBe(anchoring);
  });

  it('anchors native growth above the streaming response from touch-down until release', async () => {
    const app = await setup();
    await app.scroll(12);
    expect(app.listProps().maintainVisibleContentPosition).toBeUndefined();
    await fireEvent(app.list(), 'touchStart');
    expect(app.listProps().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    await fireEvent(app.list(), 'scrollBeginDrag');
    await app.scroll(12);
    await fireEvent(app.list(), 'scrollEndDrag', { nativeEvent: { velocity: { x: 0, y: 0 } } });
    expect(app.listProps().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    expect(app.listProps().maintainVisibleContentPosition).toBeUndefined();
  });

  it('uses a zero-height history edge when an agent transcript has no user anchor', async () => {
    const app = await setup();
    await app.update({
      ...runningChat,
      messages: runningChat.messages.filter((message) => message.role === 'assistant'),
    });
    await fireEvent(app.list(), 'touchStart');
    expect(app.listProps().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    expect(app.listProps().ListFooterComponent).not.toBeNull();
    expect(app.listProps().ListFooterComponentStyle).toBeUndefined();
  });

  it('does not jump when a finger starts anchoring a transcript that grew since its last anchor', async () => {
    const app = await setup();
    const native = createNativeAnchoringModel(12);
    let answerHeight = 100;
    const commit = () => {
      const content = measureNativeContent(app, answerHeight);
      native.mount(content.position, content.frames);
    };
    const stream = async (height: number, status: Chat['status'] = 'running') => {
      answerHeight = height;
      await app.update({
        ...runningChat,
        status,
        messages: runningChat.messages.map((message) =>
          message.role === 'assistant'
            ? { ...message, content: `Streaming ${String(height)}`, pending: status === 'running' }
            : message,
        ),
      });
      commit();
    };
    await app.scroll(12);
    commit();

    // A brief touch during the run anchors the prompt, then output keeps streaming untouched.
    await fireEvent(app.list(), 'touchStart');
    commit();
    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    commit();
    await stream(400);

    let offset = native.offset;
    await fireEvent(app.list(), 'touchStart');
    commit();
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    expect(native.offset).toBe(offset);
    await stream(550);
    expect(native.offset).toBe(offset + 150);
    await fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    commit();
    await stream(900);
    await stream(900, 'complete');
    expect(app.tree.queryByLabelText('Jump to latest message')).toBeNull();

    // Browsing the settled transcript starts anchoring under the finger once it leaves the latest.
    await fireEvent(app.list(), 'touchStart');
    commit();
    await fireEvent(app.list(), 'scrollBeginDrag');
    native.drag(160);
    await app.scroll(160);
    offset = native.offset;
    commit();
    expect(native.offset).toBe(offset);
    expect(app.tree.getByLabelText('Jump to latest message')).toBeTruthy();
    expect(app.listProps().maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    expect(measureNativeContent(app, answerHeight).position).toEqual({ minIndexForVisible: 2 });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    // The model's idle anchor assumes a real first child pinned to the content origin.
    const [sentinel] = measureNativeContent(app, answerHeight).children;
    expect(sentinel?.key).toBeNull();
    expect(sentinel?.props.collapsable).toBe(false);
    expect(sentinel?.props.style).toEqual({
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: 0,
    });
    // Programmatic scrolls (pinning, jump to latest) still reach the native scroll view.
    expect(app.scrollRef.current?.getNativeScrollRef()).toBeInstanceOf(ScrollView);
  });
});
