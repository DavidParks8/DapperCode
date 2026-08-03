import { useCallback, useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

const OVERFLOW_EPSILON = 1;

export function useHorizontalOverflow() {
  const viewportWidth = useRef(0);
  const contentWidth = useRef(0);
  const offsetX = useRef(0);
  const fadeVisible = useRef(false);
  const [showEndFade, setShowEndFade] = useState(false);
  const updateFade = useCallback(() => {
    const next =
      contentWidth.current > viewportWidth.current + OVERFLOW_EPSILON &&
      offsetX.current + viewportWidth.current < contentWidth.current - OVERFLOW_EPSILON;
    if (next !== fadeVisible.current) {
      fadeVisible.current = next;
      setShowEndFade(next);
    }
  }, []);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidth.current = event.nativeEvent.layout.width;
      updateFade();
    },
    [updateFade],
  );
  const onContentSizeChange = useCallback(
    (width: number) => {
      contentWidth.current = width;
      updateFade();
    },
    [updateFade],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offsetX.current = event.nativeEvent.contentOffset.x;
      updateFade();
    },
    [updateFade],
  );
  return {
    onLayout,
    onContentSizeChange,
    onScroll,
    showEndFade,
  };
}

export function horizontalFadeColors(backgroundColor: string): [string, string] {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(backgroundColor);
  if (!match) {
    return ['rgba(0, 0, 0, 0)', backgroundColor];
  }
  const red = Number.parseInt(match[1] ?? '0', 16);
  const green = Number.parseInt(match[2] ?? '0', 16);
  const blue = Number.parseInt(match[3] ?? '0', 16);
  return [`rgba(${String(red)}, ${String(green)}, ${String(blue)}, 0)`, backgroundColor];
}

export function compositeOverlayColor(backgroundColor: string, overlayColor: string): string {
  const background = parseHexColor(backgroundColor);
  const overlay = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(
    overlayColor,
  );
  if (!background || !overlay) {
    return backgroundColor;
  }
  const alpha = Math.min(1, Math.max(0, Number.parseFloat(overlay[4] ?? '0')));
  const result = background.map((component, index) => {
    const overlayComponent = Number.parseInt(overlay[index + 1] ?? '0', 10);
    return Math.round(overlayComponent * alpha + component * (1 - alpha));
  });
  return `#${result.map((component) => component.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  return match
    ? [
        Number.parseInt(match[1] ?? '0', 16),
        Number.parseInt(match[2] ?? '0', 16),
        Number.parseInt(match[3] ?? '0', 16),
      ]
    : null;
}
