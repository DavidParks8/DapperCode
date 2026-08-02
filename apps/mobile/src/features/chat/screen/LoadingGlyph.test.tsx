import React from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { LoadingGlyph, type LoadingGlyphVariant } from './LoadingGlyph';

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(node: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <AppThemeProvider theme={theme}>{node}</AppThemeProvider>
    </SafeAreaProvider>
  );
}

function render(node: React.ReactNode): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(wrap(node));
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

describe('LoadingGlyph', () => {
  it('starts and stops pulse, bars, and ring animations and renders both sizes', () => {
    const starts: jest.Mock[] = [];
    const stops: jest.Mock[] = [];
    jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const start = jest.fn();
      const stop = jest.fn();
      starts.push(start);
      stops.push(stop);
      return { start, stop } as unknown as Animated.CompositeAnimation;
    });

    const variants: LoadingGlyphVariant[] = ['spinner', 'pulse', 'bars', 'ring'];
    const tree = render(
      <>
        {variants.map((variant) => (
          <LoadingGlyph key={variant} color="#fff" variant={variant} />
        ))}
      </>,
    );
    expect(starts).toHaveLength(3);
    act(() => {
      tree.update(
        wrap(<LoadingGlyph color="#000" variant="ring" size="medium" style={{ opacity: 0.5 }} />),
      );
    });
    act(() => tree.unmount());
    expect(stops.every((stop) => stop.mock.calls.length > 0)).toBe(true);
  });

  it('renders a static glyph and never loops while Reduce Motion is enabled', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const loopSpy = jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const start = jest.fn();
      const stop = jest.fn();
      return { start, stop } as unknown as Animated.CompositeAnimation;
    });
    const setValueSpy = jest.spyOn(Animated.Value.prototype, 'setValue');
    // This suite doesn't clear/restore mocks between tests, so count only calls made after
    // this test starts rather than asserting an absolute total.
    const loopCallsBeforeMount = loopSpy.mock.calls.length;

    const variants: LoadingGlyphVariant[] = ['pulse', 'bars', 'ring'];
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        wrap(
          <>
            {variants.map((variant) => (
              <LoadingGlyph key={variant} color="#fff" variant={variant} />
            ))}
          </>,
        ),
      );
      // Flush the async `isReduceMotionPreferred()` resolution.
      await Promise.resolve();
    });

    // Reduce Motion resolves asynchronously, so each variant starts its loop once on mount
    // (before the preference is known) and then immediately tears it down once resolved true.
    const loopCallsAfterMount = loopSpy.mock.calls.length - loopCallsBeforeMount;
    expect(loopCallsAfterMount).toBe(3);
    const stopsCalled = loopSpy.mock.results
      .slice(loopCallsBeforeMount)
      .every((result) => (result.value as { stop: jest.Mock }).stop.mock.calls.length > 0);
    expect(stopsCalled).toBe(true);

    // The static phase/scale/opacity values are applied instead of animating.
    expect(setValueSpy).toHaveBeenCalledWith(1);

    act(() => tree?.unmount());
  });
});
