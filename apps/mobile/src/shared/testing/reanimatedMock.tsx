import { useRef } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';

/**
 * Reanimated needs a native worklets runtime, which Jest does not have, so every suite that renders
 * an animated component gets this synchronous double. Animations resolve to their target value
 * immediately, which keeps assertions about the settled UI honest.
 */
interface PassthroughAnimation {
  duration: () => PassthroughAnimation;
  delay: () => PassthroughAnimation;
  easing: () => PassthroughAnimation;
  springify: () => PassthroughAnimation;
  withInitialValues: () => PassthroughAnimation;
  reduceMotion: () => PassthroughAnimation;
}

function createPassthroughAnimation(): PassthroughAnimation {
  const animation: PassthroughAnimation = {
    duration: () => animation,
    delay: () => animation,
    easing: () => animation,
    springify: () => animation,
    withInitialValues: () => animation,
    reduceMotion: () => animation,
  };
  return animation;
}

export default {
  View,
  Text,
  Image,
  ScrollView,
  createAnimatedComponent: <T,>(component: T) => component,
};

export const Easing = {
  bezier: () => (value: number) => value,
  cubic: (value: number) => value,
  ease: (value: number) => value,
  in: (easing: (value: number) => number) => easing,
  inOut: (easing: (value: number) => number) => easing,
  linear: (value: number) => value,
  out: (easing: (value: number) => number) => easing,
};

export const ReduceMotion = { System: 'system', Always: 'always', Never: 'never' };
/**
 * Mutable so individual tests can simulate the device's Reduce Motion setting; defaults to off
 * so existing suites keep seeing the normal (animated) code path.
 */
let mockReducedMotionEnabled = false;
export function setMockReducedMotionEnabled(enabled: boolean): void {
  mockReducedMotionEnabled = enabled;
}
export const useReducedMotion = () => mockReducedMotionEnabled;
export const LinearTransition = createPassthroughAnimation();
export const FadeIn = createPassthroughAnimation();
export const FadeInUp = createPassthroughAnimation();
export const FadeInDown = createPassthroughAnimation();
export const FadeOut = createPassthroughAnimation();
export const ZoomIn = createPassthroughAnimation();
export const ZoomOut = createPassthroughAnimation();

export const cancelAnimation = () => {};
export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);
export const interpolate = (
  value: number,
  input: readonly [number, number],
  output: readonly [number, number],
) => {
  const [inputMin, inputMax] = input;
  const [outputMin, outputMax] = output;
  if (inputMax === inputMin) {
    return outputMin;
  }
  const ratio = (value - inputMin) / (inputMax - inputMin);
  return outputMin + ratio * (outputMax - outputMin);
};
export const interpolateColor = (_value: number, _input: number[], output: string[]) =>
  output[output.length - 1];
export const runOnJS =
  <Args extends unknown[], Result>(callback: (...args: Args) => Result) =>
  (...args: Args) =>
    callback(...args);
export const useAnimatedStyle = (factory: () => unknown) => factory();
export const useDerivedValue = <T,>(factory: () => T) => ({ value: factory() });
interface MockFrameCallback {
  callback: (frame: {
    timestamp: number;
    timeSinceFirstFrame: number;
    timeSincePreviousFrame: number | null;
  }) => void;
  active: boolean;
  elapsedMs: number;
  setActive(active: boolean): void;
}

export const mockFrameCallbacks: MockFrameCallback[] = [];

export function resetMockFrameCallbacks(): void {
  mockFrameCallbacks.length = 0;
}

export function advanceMockAnimationFrame(deltaMs: number): void {
  mockFrameCallbacks.forEach((frameCallback) => {
    if (!frameCallback.active) {
      return;
    }
    frameCallback.elapsedMs += deltaMs;
    frameCallback.callback({
      timestamp: frameCallback.elapsedMs,
      timeSinceFirstFrame: frameCallback.elapsedMs,
      timeSincePreviousFrame: deltaMs,
    });
  });
}

export function useFrameCallback(
  callback: MockFrameCallback['callback'],
  autostart = true,
): MockFrameCallback {
  const ref = useRef<MockFrameCallback | null>(null);
  if (!ref.current) {
    const frameCallback: MockFrameCallback = {
      callback,
      active: autostart,
      elapsedMs: 0,
      setActive(active) {
        frameCallback.active = active;
      },
    };
    ref.current = frameCallback;
    mockFrameCallbacks.push(frameCallback);
  }
  ref.current.callback = callback;
  return ref.current;
}
/**
 * Shared values created since the last reset, in hook order, so tests can assert on the settled
 * animation target instead of reaching into worklet internals.
 */
export const mockSharedValues: { value: unknown }[] = [];

export function resetMockSharedValues(): void {
  mockSharedValues.length = 0;
}

export const useSharedValue = <T,>(initial: T) => {
  // Real shared values survive re-renders; a fresh object per render would silently reset positions.
  const ref = useRef<{ value: T } | null>(null);
  if (!ref.current) {
    ref.current = { value: initial };
    mockSharedValues.push(ref.current);
  }
  return ref.current;
};
export const withDelay = <T,>(_delay: number, value: T) => value;
export const withRepeat = <T,>(value: T) => value;
export const withSequence = <T,>(...values: T[]) => values[values.length - 1];
export const withSpring = <T,>(
  value: T,
  _config?: unknown,
  callback?: (finished: boolean) => void,
) => {
  callback?.(true);
  return value;
};
export const withTiming = <T,>(
  value: T,
  _config?: unknown,
  callback?: (finished: boolean) => void,
) => {
  callback?.(true);
  return value;
};
