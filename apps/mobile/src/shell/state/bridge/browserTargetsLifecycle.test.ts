import type { AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { bindBrowserTargetRevalidation } from '@shell/state/bridge/browserTargetsLifecycle';

describe('browser target discovery lifecycle', () => {
  it('revalidates on reconnect and foreground, then removes both listeners', () => {
    let statusListener: ((connected: boolean) => void) | null = null;
    let appStateListener: ((state: AppStateStatus) => void) | null = null;
    const unsubscribeStatus = jest.fn();
    const removeAppStateListener = jest.fn();
    let connected = false;
    const ws = {
      get isConnected() {
        return connected;
      },
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

    const cleanup = bindBrowserTargetRevalidation(ws, revalidate, appState);
    const emitStatus = statusListener as unknown as (connected: boolean) => void;
    const emitAppState = appStateListener as unknown as (state: AppStateStatus) => void;
    emitStatus(false);
    emitAppState('background');
    emitAppState('active');
    expect(revalidate).not.toHaveBeenCalled();

    connected = true;
    emitStatus(true);
    emitAppState('active');
    expect(revalidate).toHaveBeenCalledTimes(2);

    cleanup();
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
  });

  it('still observes foreground changes when no socket is available', () => {
    let appStateListener: ((state: AppStateStatus) => void) | null = null;
    const remove = jest.fn();
    const appState = {
      addEventListener: jest.fn((_type: 'change', listener: (state: AppStateStatus) => void) => {
        appStateListener = listener;
        return { remove };
      }),
    };
    const revalidate = jest.fn();

    const cleanup = bindBrowserTargetRevalidation(null, revalidate, appState);
    (appStateListener as unknown as (state: AppStateStatus) => void)('active');
    expect(revalidate).toHaveBeenCalledTimes(1);
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
