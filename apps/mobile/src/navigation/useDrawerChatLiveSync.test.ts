import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import type { HostBridgeWsClient } from '../api/ws';
import type { RpcNotification } from '../api/types';
import {
  DRAWER_REFRESH_CONNECTED_MS,
  DRAWER_REFRESH_DISCONNECTED_MS,
} from './drawerChatLoadingConfig';
import { useDrawerChatLiveSync, type DrawerChatLiveSyncControls } from './useDrawerChatLiveSync';
import type { DrawerRunIndicatorMap } from './drawerRuntimeIndicators';

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
} {
  let latestControls!: DrawerChatLiveSyncControls;
  let currentProps: ProbeProps = { ws: harness.ws, ...initialProps };

  function Probe(props: ProbeProps) {
    latestControls = useDrawerChatLiveSync({
      active: props.active,
      onThreadDeleted: jest.fn(),
      scheduleLoadChats: props.scheduleLoadChats,
      setRunIndicators: jest.fn() as unknown as (
        update:
          DrawerRunIndicatorMap | ((previous: DrawerRunIndicatorMap) => DrawerRunIndicatorMap),
      ) => void,
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
  };
}

describe('useDrawerChatLiveSync poll timer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
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

  it('uses the disconnected cadence and resetPollTimer respects it when reactivated', () => {
    const harness = createWsHarness();
    const scheduleLoadChats = jest.fn();
    const { controls, rerender } = renderLiveSync(harness, {
      active: true,
      wsConnected: false,
      scheduleLoadChats,
    });

    act(() => {
      controls().resetPollTimer();
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(DRAWER_REFRESH_DISCONNECTED_MS);
    });
    expect(scheduleLoadChats).toHaveBeenCalledTimes(2);

    rerender({ wsConnected: true });
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
