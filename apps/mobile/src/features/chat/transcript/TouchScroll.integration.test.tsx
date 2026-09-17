import { act, fireEvent, render } from '@testing-library/react-native';
import { createRef } from 'react';
import { FlatList } from 'react-native';
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
      id: 'answer',
      role: 'assistant',
      content: 'Streaming',
      pending: true,
      createdAt: '2026-09-16T00:00:00.000Z',
    },
  ],
} satisfies Chat;

function setup() {
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
  const tree = render(element(runningChat));
  if (!scrollRef.current || !recoveryRef.current) {
    throw new Error('Expected mounted transcript and scroll controller');
  }
  const recovery = recoveryRef.current;
  const scrollToOffset = jest
    .spyOn(scrollRef.current, 'scrollToOffset')
    .mockImplementation(() => {});
  const list = () => tree.UNSAFE_getByType(FlatList);
  const scroll = (y: number, height = 1000) =>
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 390, height },
        layoutMeasurement: { width: 390, height: 600 },
      },
    });
  return {
    tree,
    list,
    scroll,
    scrollToOffset,
    recovery,
    context,
    update: (chat: Chat) => tree.rerender(element(chat)),
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

  it('cancels an already queued animation frame when a stationary finger touches the transcript', () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const app = setup();
    app.scroll(12);
    act(() => {
      app.recovery.scrollToBottomIfPinned(false);
      jest.advanceTimersByTime(0);
    });
    expect(frames).toHaveLength(1);

    fireEvent(app.list(), 'touchStart');
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    act(() => frames[0]?.(0));
    fireEvent(app.list(), 'contentSizeChange', 390, 1200);
    act(() => jest.advanceTimersByTime(1000));
    expect(app.scrollToOffset).not.toHaveBeenCalled();

    fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(false);
    fireEvent(app.list(), 'contentSizeChange', 390, 1400);
    act(() => jest.advanceTimersByTime(0));
    act(() => frames.at(-1)?.(0));
    expect(app.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it('suppresses auto-scroll through streamed updates until the last finger lifts', () => {
    const app = setup();
    fireEvent(app.list(), 'touchStart');
    fireEvent(app.list(), 'scrollBeginDrag');
    app.scroll(12);
    fireEvent(app.list(), 'scrollEndDrag');
    fireEvent(app.list(), 'momentumScrollEnd');

    for (const height of [1100, 1200, 1300]) {
      app.update({
        ...runningChat,
        messages: [{ ...runningChat.messages[0]!, content: `Streaming ${String(height)}` }],
      });
      expect(app.tree.getByText(`Streaming ${String(height)}`)).toBeTruthy();
      fireEvent(app.list(), 'contentSizeChange', 390, height);
      act(() => {
        app.recovery.schedulePinnedScrollToBottom();
        app.recovery.scrollToBottomReliable();
        jest.advanceTimersByTime(500);
      });
      expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
      expect(app.scrollToOffset).not.toHaveBeenCalled();
    }

    fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [{ identifier: 1 }] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(false);
    fireEvent(app.list(), 'contentSizeChange', 390, 1500);
    act(() => jest.advanceTimersByTime(500));
    expect(app.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it('does not replay a cancelled frame after a history drag is released', () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const app = setup();
    act(() => {
      app.recovery.scrollToBottomIfPinned(false);
      jest.advanceTimersByTime(0);
    });
    expect(frames).toHaveLength(1);
    fireEvent(app.list(), 'touchStart');
    fireEvent(app.list(), 'scrollBeginDrag');
    app.scroll(160);
    fireEvent(app.list(), 'touchEnd', { nativeEvent: { touches: [] } });
    fireEvent(app.list(), 'scrollEndDrag');
    act(() => frames[0]?.(0));
    expect(app.scrollToOffset).not.toHaveBeenCalled();
    expect(app.tree.getByLabelText('Jump to latest message')).toBeTruthy();
    expect(app.recovery.autoScrollStateRef.current.shouldStickToBottom).toBe(false);
    fireEvent.press(app.tree.getByLabelText('Jump to latest message'));
    act(() => jest.advanceTimersByTime(0));
    act(() => frames.at(-1)?.(0));
    expect(app.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
    expect(app.tree.queryByLabelText('Jump to latest message')).toBeNull();
  });

  it('rechecks pinned state when a throttled scroll becomes due', () => {
    const app = setup();
    app.context.lastPinnedScrollAtRef.current = Date.now();
    act(() => app.recovery.schedulePinnedScrollToBottom(false));
    expect(app.context.scheduledPinnedScrollTimeoutRef.current).not.toBeNull();
    app.recovery.autoScrollStateRef.current.shouldStickToBottom = false;
    act(() => jest.advanceTimersByTime(500));
    expect(app.scrollToOffset).not.toHaveBeenCalled();
  });

  it('preserves native drag ownership on touch cancellation and clears it after momentum', () => {
    const app = setup();
    fireEvent(app.list(), 'touchStart');
    fireEvent(app.list(), 'scrollBeginDrag');
    fireEvent(app.list(), 'touchCancel', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(true);
    app.scroll(160);
    fireEvent(app.list(), 'scrollEndDrag');
    fireEvent(app.list(), 'momentumScrollBegin');
    fireEvent(app.list(), 'contentSizeChange', 390, 1200);
    act(() => jest.advanceTimersByTime(500));
    expect(app.scrollToOffset).not.toHaveBeenCalled();
    fireEvent(app.list(), 'momentumScrollEnd');
    expect(app.recovery.autoScrollStateRef.current).toEqual({
      shouldStickToBottom: false,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
  });

  it('releases a cancelled touch that never became a drag and resets contact on chat navigation', () => {
    const app = setup();
    fireEvent(app.list(), 'touchStart');
    fireEvent(app.list(), 'touchCancel', { nativeEvent: { touches: [] } });
    expect(app.recovery.autoScrollStateRef.current.isUserInteracting).toBe(false);
    expect(app.recovery.autoScrollStateRef.current.shouldStickToBottom).toBe(true);

    fireEvent(app.list(), 'touchStart');
    fireEvent(app.list(), 'scrollBeginDrag');
    app.update({ ...runningChat, id: 'next-chat' });
    fireEvent(app.list(), 'momentumScrollEnd');
    expect(app.recovery.autoScrollStateRef.current).toEqual({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
  });
});
