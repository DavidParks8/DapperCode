import type { Chat } from '@bridge/types/types';
import { Provider, createStore, useAtomValue } from 'jotai';
import { Text } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { activityAtom } from '../state/composer';
import { activeTurnIdAtom, stoppingTurnAtom } from '../state/turn';
import {
  useMainScreenReasoningAndInterrupt,
  type MainScreenReasoningAndInterruptContext,
} from './reasoningAndInterrupt';
import { useMainScreenTurnStopControl } from './stopControl';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

/**
 * A worker that dies mid-turn leaves the thread advertising `running` with no interruptible turn
 * behind it, so the bridge answers an interrupt with "there is no active turn" and never emits a
 * lifecycle event. This is the shape the transport reports in that state.
 */
function abandonedRunningThread(): Chat {
  return {
    id: 'thread',
    title: 'Thread',
    status: 'running',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    statusUpdatedAt: '2026-08-08T00:00:00.000Z',
    lastMessagePreview: '',
    messages: [],
  };
}

interface Harness {
  tree: ReactTestRenderer;
  pressStop: () => Promise<void>;
  interrupt: jest.Mock;
  chat: () => Chat | null;
  state: () => {
    stopping: boolean;
    activeTurnId: string | null;
    activityTitle: string;
    showStopButton: boolean;
  };
}

function mountStopControl(): Harness {
  const store = createStore();
  // The bridge finds no turn in an interruptible state, so it reports back without interrupting.
  const interrupt = jest.fn().mockResolvedValue(null);
  let chat: Chat | null = abandonedRunningThread();
  let pressStop: (() => void) | undefined;

  function Probe() {
    const interruptApi = useMainScreenReasoningAndInterrupt({
      appendLocalSystemMessage: jest.fn(),
      chatIdRef: { current: 'thread' },
      clearRunWatchdog: jest.fn(),
      liveReasoningBuffersRef: { current: {} },
      liveReasoningMessageIdsRef: { current: {} },
      schedulePinnedScrollToBottom: jest.fn(),
      setSelectedChat: (update: Chat | null | ((prev: Chat | null) => Chat | null)) => {
        chat = typeof update === 'function' ? update(chat) : update;
      },
      stopRequestedRef: { current: false },
      stopSystemMessageLoggedRef: { current: false },
      turnExecutionController: { interrupt },
    } as unknown as MainScreenReasoningAndInterruptContext);

    const control = useMainScreenTurnStopControl({
      activeTurnIdRef: { current: null },
      chatIdRef: { current: 'thread' },
      setSelectedChat: (update: Chat | null | ((prev: Chat | null) => Chat | null)) => {
        chat = typeof update === 'function' ? update(chat) : update;
      },
      stopRequestedRef: { current: false },
      stopSystemMessageLoggedRef: { current: false },
      ...interruptApi,
    } as unknown as Parameters<typeof useMainScreenTurnStopControl>[0]);

    pressStop = control.handleStopTurn;
    const stopping = useAtomValue(stoppingTurnAtom);
    return <Text>{String(stopping)}</Text>;
  }

  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <Provider store={store}>
        <Probe />
      </Provider>,
    );
  });
  if (!tree) {
    throw new Error('Expected a mounted probe');
  }

  return {
    tree,
    pressStop: async () => {
      await act(async () => {
        pressStop?.();
      });
    },
    interrupt,
    chat: () => chat,
    state: () => {
      const stopping = store.get(stoppingTurnAtom);
      const activeTurnId = store.get(activeTurnIdAtom);
      const current = chat;
      // Mirrors composer/renderer.tsx: showStopButton = isTurnLoading || isTurnLikelyRunning || stoppingTurn
      const isTurnLikelyRunning = Boolean(activeTurnId) || current?.status === 'running';
      return {
        stopping,
        activeTurnId,
        activityTitle: store.get(activityAtom).title,
        showStopButton: isTurnLikelyRunning || stopping,
      };
    },
  };
}

describe('stopping a thread whose turn was abandoned by a dead worker', () => {
  it('retires the stale running status so the stop button cannot survive the press', async () => {
    const harness = mountStopControl();

    // The composer offers a stop button purely because the thread still advertises `running`.
    expect(harness.state().showStopButton).toBe(true);

    await harness.pressStop();

    expect(harness.interrupt).toHaveBeenCalledWith('thread');
    expect(harness.state()).toMatchObject({
      stopping: false,
      activeTurnId: null,
      activityTitle: 'No active turn found',
      showStopButton: false,
    });
    expect(harness.chat()?.status).toBe('complete');

    act(() => harness.tree.unmount());
  });

  it('stays settled instead of re-offering a stop button on a second press', async () => {
    const harness = mountStopControl();

    await harness.pressStop();
    await harness.pressStop();

    expect(harness.state().showStopButton).toBe(false);
    expect(harness.chat()?.status).toBe('complete');

    act(() => harness.tree.unmount());
  });

  it('leaves a genuinely interruptible turn to the normal lifecycle path', async () => {
    const store = createStore();
    const interrupt = jest.fn().mockResolvedValue('turn-9');
    let chat: Chat | null = abandonedRunningThread();
    let pressStop: (() => void) | undefined;

    function Probe() {
      const interruptApi = useMainScreenReasoningAndInterrupt({
        appendLocalSystemMessage: jest.fn(),
        chatIdRef: { current: 'thread' },
        clearRunWatchdog: jest.fn(),
        liveReasoningBuffersRef: { current: {} },
        liveReasoningMessageIdsRef: { current: {} },
        schedulePinnedScrollToBottom: jest.fn(),
        setSelectedChat: (update: Chat | null | ((prev: Chat | null) => Chat | null)) => {
          chat = typeof update === 'function' ? update(chat) : update;
        },
        stopRequestedRef: { current: false },
        stopSystemMessageLoggedRef: { current: false },
        turnExecutionController: { interrupt },
      } as unknown as MainScreenReasoningAndInterruptContext);

      const control = useMainScreenTurnStopControl({
        activeTurnIdRef: { current: null },
        chatIdRef: { current: 'thread' },
        setSelectedChat: (update: Chat | null | ((prev: Chat | null) => Chat | null)) => {
          chat = typeof update === 'function' ? update(chat) : update;
        },
        stopRequestedRef: { current: false },
        stopSystemMessageLoggedRef: { current: false },
        ...interruptApi,
      } as unknown as Parameters<typeof useMainScreenTurnStopControl>[0]);

      pressStop = control.handleStopTurn;
      return <Text>{String(useAtomValue(stoppingTurnAtom))}</Text>;
    }

    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Provider store={store}>
          <Probe />
        </Provider>,
      );
    });

    await act(async () => {
      pressStop?.();
    });

    // A real interrupt is in flight, so the turn must stay pending its terminal event.
    expect(store.get(activityAtom).title).toBe('Stopping turn');
    expect(store.get(activeTurnIdAtom)).toBe('turn-9');
    expect(chat?.status).toBe('running');

    act(() => tree?.unmount());
  });
});
