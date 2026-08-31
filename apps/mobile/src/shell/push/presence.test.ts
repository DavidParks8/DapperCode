import type { AppStateStatus } from 'react-native';

import type { RpcNotification } from '@bridge/types/types';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import { bindPushForegroundPresence, PUSH_PRESENCE_RENEW_INTERVAL_MS } from '@shell/push/presence';

function requiredListener<T>(listener: T | null): T {
  if (!listener) {
    throw new Error('expected listener to be registered');
  }
  return listener;
}

function event(
  method: string,
  params: Record<string, unknown> = {},
  eventId?: number,
): RpcNotification {
  return {
    method,
    params,
    streamId: 'stream-1',
    ...(eventId === undefined ? {} : { eventId }),
  };
}

function createPresenceHarness(currentState: AppStateStatus = 'active', initiallyConnected = true) {
  let appStateListener: ((state: AppStateStatus) => void) | null = null;
  let statusListener: ((connected: boolean) => void) | null = null;
  let beforeDisconnectListener: (() => void) | null = null;
  let eventListener: ((notification: RpcNotification) => void) | null = null;
  const removeAppStateListener = jest.fn();
  const unsubscribeEvents = jest.fn();
  const unsubscribeBeforeDisconnect = jest.fn();
  const unsubscribeStatus = jest.fn();
  const reportPushPresence = jest.fn(() => true);
  const reportPushObservation = jest.fn(() => true);
  const client = {
    isConnected: initiallyConnected,
    reportPushPresence,
    reportPushObservation,
    onStatus: jest.fn((listener: (connected: boolean) => void) => {
      statusListener = listener;
      return unsubscribeStatus;
    }),
    onBeforeDisconnect: jest.fn((listener: () => void) => {
      beforeDisconnectListener = listener;
      return unsubscribeBeforeDisconnect;
    }),
    onEvent: jest.fn((listener: (notification: RpcNotification) => void) => {
      eventListener = listener;
      return unsubscribeEvents;
    }),
  };
  const appState = {
    currentState,
    addEventListener: jest.fn((_type: 'change', listener: (state: AppStateStatus) => void) => {
      appStateListener = listener;
      return { remove: removeAppStateListener };
    }),
  };
  const cleanup = bindPushForegroundPresence(client as unknown as HostBridgeWsClient, appState);

  return {
    reportPushPresence,
    reportPushObservation,
    removeAppStateListener,
    unsubscribeEvents,
    unsubscribeBeforeDisconnect,
    unsubscribeStatus,
    emitAppState(state: AppStateStatus) {
      appState.currentState = state;
      requiredListener(appStateListener)(state);
    },
    emitStatus(connected: boolean) {
      client.isConnected = connected;
      requiredListener(statusListener)(connected);
    },
    emitBeforeDisconnect() {
      requiredListener(beforeDisconnectListener)();
    },
    emitEvent(notification: RpcNotification) {
      requiredListener(eventListener)(notification);
    },
    cleanup,
  };
}

describe('push foreground presence', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes lifecycle state even when the socket remains connected', () => {
    const harness = createPresenceHarness();
    expect(harness.reportPushPresence).toHaveBeenLastCalledWith(true);

    harness.emitAppState('inactive');
    expect(harness.reportPushPresence).toHaveBeenLastCalledWith(true);
    harness.emitAppState('background');
    expect(harness.reportPushPresence).toHaveBeenLastCalledWith(false);
    harness.emitEvent(
      event('bridge/push/candidate', {
        candidateId: 'background-candidate',
        afterEventId: 1,
      }),
    );
    expect(harness.reportPushObservation).not.toHaveBeenCalled();

    harness.emitAppState('active');
    harness.emitBeforeDisconnect();
    expect(harness.reportPushPresence).toHaveBeenLastCalledWith(false);
    harness.emitStatus(true);
    expect(harness.reportPushPresence).toHaveBeenLastCalledWith(true);

    harness.cleanup();
    expect(harness.reportPushPresence).toHaveBeenLastCalledWith(false);
    expect(harness.removeAppStateListener).toHaveBeenCalled();
    expect(harness.unsubscribeEvents).toHaveBeenCalled();
    expect(harness.unsubscribeBeforeDisconnect).toHaveBeenCalled();
    expect(harness.unsubscribeStatus).toHaveBeenCalled();
  });

  it('acknowledges only after the numbered stream reaches the candidate watermark', () => {
    const harness = createPresenceHarness();
    harness.emitEvent(event('bridge/agui.event', {}, 7));
    harness.emitEvent(
      event('bridge/push/candidate', { candidateId: 'candidate-1', afterEventId: 7 }),
    );
    expect(harness.reportPushObservation).toHaveBeenCalledWith('candidate-1');

    harness.reportPushObservation.mockClear();
    harness.emitEvent(
      event('bridge/push/candidate', { candidateId: 'candidate-after-gap', afterEventId: 9 }),
    );
    expect(harness.reportPushObservation).not.toHaveBeenCalled();
    harness.emitEvent(event('bridge/agui.event', {}, 9));
    expect(harness.reportPushObservation).toHaveBeenCalledWith('candidate-after-gap');
    harness.cleanup();
  });

  it('drops pending observations across disconnect and snapshot recovery', () => {
    const harness = createPresenceHarness();
    harness.emitEvent(
      event('bridge/push/candidate', { candidateId: 'candidate-before-drop', afterEventId: 11 }),
    );
    harness.emitStatus(false);
    harness.emitStatus(true);
    harness.emitEvent(event('bridge/agui.event', {}, 11));
    expect(harness.reportPushObservation).not.toHaveBeenCalled();

    harness.emitEvent(
      event('bridge/push/candidate', {
        candidateId: 'candidate-before-snapshot',
        afterEventId: 13,
      }),
    );
    harness.emitEvent(event('bridge/events/snapshotRequired'));
    harness.emitEvent(event('bridge/agui.event', {}, 13));
    expect(harness.reportPushObservation).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it('bounds candidates waiting behind a persistent replay gap', () => {
    const harness = createPresenceHarness();
    harness.emitEvent(event('bridge/agui.event', {}, 13));
    for (let index = 0; index < 129; index += 1) {
      harness.emitEvent(
        event('bridge/push/candidate', {
          candidateId: `bounded-${index}`,
          afterEventId: 100 + index,
        }),
      );
    }
    harness.emitEvent(event('bridge/agui.event', {}, 228));
    expect(harness.reportPushObservation).toHaveBeenCalledTimes(128);
    expect(harness.reportPushObservation).not.toHaveBeenCalledWith('bounded-0');
    expect(harness.reportPushObservation).toHaveBeenCalledWith('bounded-128');
    harness.cleanup();
  });

  it('waits for a connection before publishing the current state', () => {
    const harness = createPresenceHarness('background', false);
    expect(harness.reportPushPresence).not.toHaveBeenCalled();
    harness.emitStatus(true);
    expect(harness.reportPushPresence).toHaveBeenCalledWith(false);
    harness.cleanup();
  });

  it('renews foreground leases while the socket stays connected', () => {
    jest.useFakeTimers();
    const harness = createPresenceHarness();
    harness.reportPushPresence.mockClear();
    jest.advanceTimersByTime(PUSH_PRESENCE_RENEW_INTERVAL_MS * 2);
    expect(harness.reportPushPresence).toHaveBeenCalledTimes(2);
    expect(harness.reportPushPresence).toHaveBeenNthCalledWith(1, true);
    expect(harness.reportPushPresence).toHaveBeenNthCalledWith(2, true);
    harness.cleanup();
  });
});
