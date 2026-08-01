import type { AppStateStatus } from 'react-native';

import {
  bindChatSnapshotBackgroundFlush,
  createChatSnapshotPersistScheduler,
} from './chatSnapshotPersistLifecycle';

describe('chat snapshot persist scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('debounces rapid schedule() calls to a single write of the newest value', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const first = jest.fn();
    const second = jest.fn();

    scheduler.schedule(first, 250);
    jest.advanceTimersByTime(200);
    scheduler.schedule(second, 250);
    jest.advanceTimersByTime(250);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel() discards a pending write without ever running it', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();

    scheduler.schedule(write, 250);
    scheduler.cancel();
    jest.advanceTimersByTime(250);

    expect(write).not.toHaveBeenCalled();
  });

  it('flush() runs the pending write immediately instead of waiting for the debounce delay', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();

    scheduler.schedule(write, 250);
    jest.advanceTimersByTime(50);
    scheduler.flush();

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('flush() never fires the same write twice, and the debounce timer never fires again after flush', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();

    scheduler.schedule(write, 250);
    scheduler.flush();
    scheduler.flush();
    jest.advanceTimersByTime(250);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op when nothing is pending', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    scheduler.flush();
    scheduler.flush();
    // No throw, and nothing to assert on writes since none was ever scheduled.
  });

  it('cancel() immediately followed by schedule() in the same tick reschedules cleanly (dependency-change reschedule)', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const stale = jest.fn();
    const fresh = jest.fn();

    scheduler.schedule(stale, 250);
    // Simulates an effect cleanup (cancel) immediately followed by the next
    // effect run scheduling the newer write, as happens when
    // activeChat/selectedChatId change before the debounce delay elapses.
    scheduler.cancel();
    scheduler.schedule(fresh, 250);
    jest.advanceTimersByTime(250);

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe('bindChatSnapshotBackgroundFlush', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function createFakeAppState() {
    let listener: ((state: AppStateStatus) => void) | null = null;
    const remove = jest.fn(() => {
      listener = null;
    });
    const addEventListener = jest.fn(
      (_type: 'change', callback: (state: AppStateStatus) => void) => {
        listener = callback;
        return { remove };
      },
    );
    return {
      appState: { addEventListener },
      emit: (state: AppStateStatus) => listener?.(state),
      remove,
    };
  }

  it('flushes the newest pending snapshot write when the app backgrounds (update -> background)', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();
    const { appState, emit } = createFakeAppState();

    bindChatSnapshotBackgroundFlush(scheduler, appState);
    scheduler.schedule(write, 250);
    jest.advanceTimersByTime(50);
    emit('background');

    expect(write).toHaveBeenCalledTimes(1);

    // The already-flushed write must not fire again once its original delay
    // would have elapsed - that would be a duplicate/stale write.
    jest.advanceTimersByTime(250);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not flush when the app state stays active', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();
    const { appState, emit } = createFakeAppState();

    bindChatSnapshotBackgroundFlush(scheduler, appState);
    scheduler.schedule(write, 250);
    emit('active');
    jest.advanceTimersByTime(100);

    expect(write).not.toHaveBeenCalled();
    jest.advanceTimersByTime(150);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('flushes the newest pending snapshot write on cleanup/unmount (update -> unmount)', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();
    const { appState, remove } = createFakeAppState();

    const cleanup = bindChatSnapshotBackgroundFlush(scheduler, appState);
    scheduler.schedule(write, 250);
    jest.advanceTimersByTime(50);
    cleanup();

    expect(write).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);

    // Nothing should still be pending after the flush-on-cleanup, so
    // advancing time further must not fire a stale duplicate write.
    jest.advanceTimersByTime(250);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a write when the app backgrounds and then the hook unmounts', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();
    const { appState, emit } = createFakeAppState();

    const cleanup = bindChatSnapshotBackgroundFlush(scheduler, appState);
    scheduler.schedule(write, 250);
    emit('background');
    cleanup();

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('removes the app state listener on cleanup and no longer flushes on later background events', () => {
    const scheduler = createChatSnapshotPersistScheduler();
    const write = jest.fn();
    const { appState, emit, remove } = createFakeAppState();

    const cleanup = bindChatSnapshotBackgroundFlush(scheduler, appState);
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);

    scheduler.schedule(write, 250);
    emit('background');
    expect(write).not.toHaveBeenCalled();
  });
});
