import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import type { RpcNotification } from '@bridge/types/types';
import { DRAWER_REFRESH_CONNECTED_MS } from '@shell/navigation/drawerChatLoadingConfig';
import {
  useDrawerChatLiveSync,
  type DrawerChatLiveSyncControls,
} from '@shell/navigation/useDrawerChatLiveSync';

interface Harness {
  ws: HostBridgeWsClient;
  emitEvent: (event: RpcNotification) => void;
  emitStatus: (connected: boolean) => void;
}

function createWsHarness(): Harness {
  const eventHandlers = new Set<(event: RpcNotification) => void>();
  const statusHandlers = new Set<(connected: boolean) => void>();
  const ws = {
    onEvent: jest.fn().mockImplementation((handler) => {
      eventHandlers.add(handler);
      return jest.fn(() => eventHandlers.delete(handler));
    }),
    onStatus: jest.fn().mockImplementation((handler) => {
      statusHandlers.add(handler);
      return jest.fn(() => statusHandlers.delete(handler));
    }),
  } as unknown as HostBridgeWsClient;
  return {
    ws,
    emitEvent: (event) => eventHandlers.forEach((handler) => handler(event)),
    emitStatus: (connected) => statusHandlers.forEach((handler) => handler(connected)),
  };
}

interface ProbeProps {
  active: boolean;
  wsConnected: boolean;
  ws: HostBridgeWsClient;
  scheduleLoadChats: (delay?: number, forceRefresh?: boolean) => void;
}

function renderLiveSync(
  harness: Harness,
  initialProps: { active: boolean; wsConnected: boolean; scheduleLoadChats: jest.Mock },
): {
  tree: ReactTestRenderer;
  controls: () => DrawerChatLiveSyncControls;
  rerender: (props: Partial<ProbeProps>) => void;
  cancelMaintenanceWork: jest.Mock;
  setRunIndicators: jest.Mock;
} {
  let latestControls!: DrawerChatLiveSyncControls;
  let currentProps: ProbeProps = { ws: harness.ws, ...initialProps };
  const cancelMaintenanceWork = jest.fn();
  const setRunIndicators = jest.fn();
  const refreshFullHistoryRef = { current: jest.fn(async () => {}) };

  function Probe(props: ProbeProps) {
    latestControls = useDrawerChatLiveSync({
      active: props.active,
      cancelMaintenanceWork,
      onThreadDeleted: jest.fn(),
      refreshFullHistoryRef,
      scheduleLoadChats: props.scheduleLoadChats,
      setRunIndicators,
      setWsConnected: jest.fn(),
      ws: props.ws,
      wsConnected: props.wsConnected,
    });
    return null;
  }

  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(createElement(Probe, currentProps));
  });

  return {
    tree,
    controls: () => latestControls,
    rerender: (nextProps) => {
      currentProps = { ...currentProps, ...nextProps };
      act(() => {
        tree.update(createElement(Probe, currentProps));
      });
    },
    cancelMaintenanceWork,
    setRunIndicators,
  };
}

describe('useDrawerChatLiveSync poll timer', () => {
  let appStateListener: ((state: AppStateStatus) => void) | null;
  let appStateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    appStateListener = null;
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    appStateSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        appStateListener = listener;
        return { remove: jest.fn() };
      });
  });

  afterEach(() => {
    appStateSpy.mockRestore();
    jest.useRealTimers();
  });

  it('polls scheduleLoadChats at the connected cadence', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    renderLiveSync(harness, { active: true, wsConnected: true, scheduleLoadChats });

    expect(scheduleLoadChats).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS);
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(1);
    expect(scheduleLoadChats).toHaveBeenLastCalledWith();

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS);
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(2);
  });

  it('resetPollTimer expedites a load and restarts the interval instead of adding a second timer', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { controls } = renderLiveSync(harness, {
      active: true,
      wsConnected: true,
      scheduleLoadChats,
    });

    // Move partway through the poll interval, simulating an app that has been active a while.
    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS - 1000);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();

    // Foreground resume: reset/expedite the poll timer rather than issuing a separate fetch.
    act(() => {
      controls().resetPollTimer(250, true);
    });
    // The expedited load goes through the same scheduleLoadChats the poll timer itself uses.
    expect(scheduleLoadChats).toHaveBeenCalledTimes(1);
    expect(scheduleLoadChats).toHaveBeenLastCalledWith(250, true);

    // The old pending tick (which would have landed 1s from the reset) must not also fire —
    // otherwise the reset would be adding a second, competing timer instead of replacing it.
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(1);

    // A fresh full interval after the reset point resumes normal polling.
    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS - 1000);
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(2);
    expect(scheduleLoadChats).toHaveBeenLastCalledWith();
  });

  it('does not poll while disconnected and starts one connected loop after reconnecting', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { rerender } = renderLiveSync(harness, {
      active: true,
      wsConnected: false,
      scheduleLoadChats,
    });

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS * 2);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();

    rerender({ wsConnected: true });
    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS);
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(1);
  });

  it('does not expedite anything while inactive', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { controls, rerender } = renderLiveSync(harness, {
      active: true,
      wsConnected: true,
      scheduleLoadChats,
    });

    rerender({ active: false });
    act(() => {
      controls().resetPollTimer(250, true);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();
  });

  it('cancels the poll timer when the drawer goes inactive (no stray fetch after deactivation)', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { rerender } = renderLiveSync(harness, {
      active: true,
      wsConnected: true,
      scheduleLoadChats,
    });

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS - 500);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();

    rerender({ active: false });

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS * 2);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();
  });

  it('pauses polling and pruning in the background, then resumes each with one timer', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { cancelMaintenanceWork, setRunIndicators } = renderLiveSync(harness, {
      active: true,
      wsConnected: true,
      scheduleLoadChats,
    });

    act(() => {
      jest.advanceTimersByTime(4000);
      appStateListener?.('background');
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS * 2);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();
    expect(setRunIndicators).not.toHaveBeenCalled();
    expect(cancelMaintenanceWork).toHaveBeenCalled();

    act(() => appStateListener?.('active'));
    act(() => jest.advanceTimersByTime(5000));
    expect(setRunIndicators).toHaveBeenCalledTimes(1);
    expect(scheduleLoadChats).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS - 5000);
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(1);

    act(() => appStateListener?.('background'));
    act(() => appStateListener?.('active'));
    act(() => jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS));
    expect(scheduleLoadChats).toHaveBeenCalledTimes(2);
  });

  it('ignores timer resets while backgrounded', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { controls } = renderLiveSync(harness, {
      active: true,
      wsConnected: true,
      scheduleLoadChats,
    });

    act(() => {
      appStateListener?.('background');
      controls().resetPollTimer(250, true);
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();
  });

  it('cancels debounced and deep-load maintenance immediately on disconnect', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { cancelMaintenanceWork } = renderLiveSync(harness, {
      active: true,
      wsConnected: true,
      scheduleLoadChats,
    });
    cancelMaintenanceWork.mockClear();

    act(() => harness.emitStatus(false));

    expect(cancelMaintenanceWork).toHaveBeenCalledTimes(1);
    expect(scheduleLoadChats).not.toHaveBeenCalled();
  });

  it('cancels the poll timer on unmount (no stray fetch after teardown)', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { tree } = renderLiveSync(harness, {
      active: true,
      wsConnected: true,
      scheduleLoadChats,
    });

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS - 500);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();

    act(() => tree.unmount());

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_CONNECTED_MS * 2);
    });
    expect(scheduleLoadChats).not.toHaveBeenCalled();
  });
});
