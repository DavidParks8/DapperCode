import type { AppStateStatus } from 'react-native';

import { bindAppWebSocketLifecycle } from '@shell/session/webSocketLifecycle';

function setup(initialState: AppStateStatus = 'active') {
  let listener: (state: AppStateStatus) => void = () => {};
  const remove = jest.fn();
  const appState = {
    currentState: initialState,
    addEventListener: jest.fn((_type: 'change', nextListener: (state: AppStateStatus) => void) => {
      listener = nextListener;
      return { remove };
    }),
  };
  const ws = { connect: jest.fn(), disconnect: jest.fn() };
  const cleanup = bindAppWebSocketLifecycle(ws, appState);
  return { ws, cleanup, remove, emit: (state: AppStateStatus) => listener(state) };
}

describe('bindAppWebSocketLifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('uses the React Native AppState source by default', () => {
    const connect = jest.fn();
    const disconnect = jest.fn();
    const ws = {
      connect,
      disconnect,
    };
    const cleanup = bindAppWebSocketLifecycle(ws);
    expect(connect.mock.calls.length + disconnect.mock.calls.length).toBeGreaterThan(0);
    cleanup();
  });

  it('keeps the connection for ten background seconds, then reconnects on foreground', () => {
    const { ws, cleanup, remove, emit } = setup();

    expect(ws.connect).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).not.toHaveBeenCalled();

    emit('inactive');
    expect(ws.connect).toHaveBeenCalledTimes(2);
    expect(ws.disconnect).not.toHaveBeenCalled();
    emit('background');
    jest.advanceTimersByTime(5_000);
    expect(ws.disconnect).not.toHaveBeenCalled();
    emit('background');
    jest.advanceTimersByTime(4_999);
    expect(ws.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(ws.disconnect).toHaveBeenCalledTimes(1);

    emit('active');
    expect(ws.connect).toHaveBeenCalledTimes(3);

    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).toHaveBeenCalledTimes(2);
  });

  it.each(['active', 'inactive'] as const)(
    'cancels a pending disconnect on a quick return to %s and grants the next lock a full window',
    (foregroundState) => {
      const { ws, cleanup, emit } = setup();
      emit('background');
      jest.advanceTimersByTime(9_999);
      emit(foregroundState);
      jest.advanceTimersByTime(20_000);
      expect(ws.disconnect).not.toHaveBeenCalled();
      expect(ws.connect).toHaveBeenCalledTimes(2);

      emit('background');
      jest.advanceTimersByTime(9_999);
      expect(ws.disconnect).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(ws.disconnect).toHaveBeenCalledTimes(1);
      cleanup();
    },
  );

  it('does not connect when initially backgrounded', () => {
    const { ws, cleanup } = setup('background');
    jest.advanceTimersByTime(10_000);
    expect(ws.connect).not.toHaveBeenCalled();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('disconnects immediately on cleanup and cancels the pending background timer', () => {
    const { ws, cleanup, remove, emit } = setup();
    emit('background');
    jest.advanceTimersByTime(5_000);
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10_000);
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
  });
});
