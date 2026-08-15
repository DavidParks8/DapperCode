import { useCallback, useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

const OVERFLOW_EPSILON = 1;

type OverflowState = { overflowing: boolean; start: boolean; end: boolean };

const NO_OVERFLOW: OverflowState = { overflowing: false, start: false, end: false };

export function useHorizontalOverflow() {
  const viewportWidth = useRef(0);
  const contentWidth = useRef(0);
  const offsetX = useRef(0);
  const measured = useRef<OverflowState>(NO_OVERFLOW);
  const [overflow, setOverflow] = useState<OverflowState>(NO_OVERFLOW);
  const updateOverflow = useCallback(() => {
    const overflowing = contentWidth.current > viewportWidth.current + OVERFLOW_EPSILON;
    const next: OverflowState = {
      overflowing,
      start: overflowing && offsetX.current > OVERFLOW_EPSILON,
      end:
        overflowing &&
        offsetX.current + viewportWidth.current < contentWidth.current - OVERFLOW_EPSILON,
    };
    if (
      next.overflowing !== measured.current.overflowing ||
      next.start !== measured.current.start ||
      next.end !== measured.current.end
    ) {
      measured.current = next;
      setOverflow(next);
    }
  }, []);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidth.current = event.nativeEvent.layout.width;
      updateOverflow();
    },
    [updateOverflow],
  );
  const onContentSizeChange = useCallback(
    (width: number) => {
      contentWidth.current = width;
      updateOverflow();
    },
    [updateOverflow],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offsetX.current = event.nativeEvent.contentOffset.x;
      updateOverflow();
    },
    [updateOverflow],
  );
  return {
    onLayout,
    onContentSizeChange,
    onScroll,
    overflowing: overflow.overflowing,
    showStartFade: overflow.start,
    showEndFade: overflow.end,
  };
}
