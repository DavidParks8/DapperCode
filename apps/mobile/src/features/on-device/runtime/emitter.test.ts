import { RuntimeSliceEmitter } from './emitter';

test('subscribers are notified only for their slices', () => {
  const emitter = new RuntimeSliceEmitter(50, () => 0);
  const chat = jest.fn();
  const library = jest.fn();
  emitter.subscribe(chat, ['threads', 'loop']);
  emitter.subscribe(library, ['downloads']);
  emitter.emit('loop');
  expect(chat).toHaveBeenCalledTimes(1);
  expect(library).not.toHaveBeenCalled();
  expect(emitter.version(['downloads'])).toBe(0);
  expect(emitter.version(['loop'])).toBe(1);
});

test('high-frequency changes notify immediately once, then at most once per interval', () => {
  jest.useFakeTimers();
  try {
    let now = 1_000;
    const emitter = new RuntimeSliceEmitter(50, () => now);
    const listener = jest.fn();
    emitter.subscribe(listener, ['threads']);
    for (let index = 0; index < 100; index += 1) {
      emitter.coalesce('threads');
    }
    expect(listener).toHaveBeenCalledTimes(1);
    now += 50;
    jest.advanceTimersByTime(50);
    expect(listener).toHaveBeenCalledTimes(2);
    emitter.coalesce('threads');
    emitter.emit('loop');
    expect(listener).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(3);
  } finally {
    jest.useRealTimers();
  }
});
