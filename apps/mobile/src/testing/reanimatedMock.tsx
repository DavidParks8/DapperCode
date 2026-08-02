import { useRef } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';

/**
 * Reanimated needs a native worklets runtime, which Jest does not have, so every suite that renders
 * an animated component gets this synchronous double. Animations resolve to their target value
 * immediately, which keeps assertions about the settled UI honest.
 */
const passthroughEntering = {
  duration: () => passthroughEntering,
  delay: () => passthroughEntering,
  easing: () => passthroughEntering,
  springify: () => passthroughEntering,
  withInitialValues: () => passthroughEntering,
};

export default {
  View,
  Text,
  Image,
  ScrollView,
  createAnimatedComponent: <T,>(component: T) => component,
};

export const Easing = {
  bezier: () => 'bezier',
  cubic: 'cubic',
  ease: 'ease',
  in: (value: unknown) => value,
  inOut: (value: unknown) => value,
  linear: 'linear',
  out: (value: unknown) => value,
};

export const ReduceMotion = { System: 'system', Always: 'always', Never: 'never' };
export const LinearTransition = passthroughEntering;
export const FadeIn = passthroughEntering;
export const FadeInUp = passthroughEntering;
export const FadeInDown = passthroughEntering;
export const FadeOut = passthroughEntering;

export const cancelAnimation = () => {};
export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);
export const interpolate = (value: number) => value;
export const interpolateColor = (_value: number, _input: number[], output: string[]) =>
  output[output.length - 1];
export const runOnJS =
  <Args extends unknown[], Result>(callback: (...args: Args) => Result) =>
  (...args: Args) =>
    callback(...args);
export const useAnimatedStyle = (factory: () => unknown) => factory();
export const useDerivedValue = <T,>(factory: () => T) => ({ value: factory() });
export const useReducedMotion = () => false;
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
    mockSharedValues.push(ref.current as { value: unknown });
  }
  return ref.current;
};
export const withDelay = <T,>(_delay: number, value: T) => value;
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
