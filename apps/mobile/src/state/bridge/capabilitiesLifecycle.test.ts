import type { AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from '../../api/ws';
import {
  bindBridgeCapabilitiesRevalidation,
  BRIDGE_CAPABILITIES_REVALIDATE_DEBOUNCE_MS,
} from './capabilitiesLifecycle';

describe('bridge capabilities lifecycle revalidation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('revalidates on setup, reconnect, and foreground with debounce', () => {
    let statusListener: ((connected: boolean) => void) | null = null;
    let appStateListener: ((state: AppStateStatus) => void) | null = null;
    const unsubscribeStatus = jest.fn();
    const removeAppStateListener = jest.fn();
    const ws = {
      onStatus: jest.fn((listener: (connected: boolean) => void) => {
        statusListener = listener;
        return unsubscribeStatus;
      }),
    } as unknown as HostBridgeWsClient;
    const appState = {
      addEventListener: jest.fn((_type: 'change', listener: (state: AppStateStatus) => void) => {
        appStateListener = listener;
        return { remove: removeAppStateListener };
      }),
    };
    const revalidate = jest.fn();

    const cleanup = bindBridgeCapabilitiesRevalidation(ws, revalidate, appState);
    jest.advanceTimersByTime(BRIDGE_CAPABILITIES_REVALIDATE_DEBOUNCE_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);

    const emitStatus = statusListener as unknown as (connected: boolean) => void;
    const emitAppState = appStateListener as unknown as (state: AppStateStatus) => void;
    emitStatus(true);
    emitAppState('active');
    jest.advanceTimersByTime(BRIDGE_CAPABILITIES_REVALIDATE_DEBOUNCE_MS - 1);
    expect(revalidate).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(revalidate).toHaveBeenCalledTimes(2);

    emitStatus(false);
    emitAppState('background');
    jest.runOnlyPendingTimers();
    expect(revalidate).toHaveBeenCalledTimes(2);

    cleanup();
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
  });
});
