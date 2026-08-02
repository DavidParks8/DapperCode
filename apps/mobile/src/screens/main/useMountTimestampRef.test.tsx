import { useEffect } from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { OPEN_CHAT_MIN_LOADING_MS } from './mainScreenConstants';
import { APP_FOCUS_DISCONNECT_GRACE_MS } from './mainScreenHelpers';
import { useMountTimestampRef } from './useMountTimestampRef';

function PassiveDeadlineHarness({
  durationMs,
  onDeadline,
}: {
  durationMs: number;
  onDeadline: () => void;
}) {
  const startedAtRef = useMountTimestampRef(true);

  useEffect(() => {
    const elapsedMs = Date.now() - startedAtRef.current;
    const timeout = setTimeout(onDeadline, Math.max(0, durationMs - elapsedMs));
    return () => clearTimeout(timeout);
  }, [durationMs, onDeadline, startedAtRef]);

  return null;
}

describe('useMountTimestampRef', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['foreground disconnect grace', APP_FOCUS_DISCONNECT_GRACE_MS],
    ['opening-chat minimum loading', OPEN_CHAT_MIN_LOADING_MS],
  ])('initializes before passive %s scheduling', (_name, durationMs) => {
    const onDeadline = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <PassiveDeadlineHarness durationMs={durationMs} onDeadline={onDeadline} />,
      );
    });

    act(() => jest.advanceTimersByTime(durationMs - 1));
    expect(onDeadline).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onDeadline).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });
});
