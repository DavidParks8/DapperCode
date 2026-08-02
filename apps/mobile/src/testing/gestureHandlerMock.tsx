import type { ReactNode } from 'react';
import { View } from 'react-native';

export interface MockGestureEvent {
  x?: number;
  y?: number;
  absoluteX?: number;
  absoluteY?: number;
  translationX?: number;
  translationY?: number;
  velocityX?: number;
  velocityY?: number;
}

export interface MockGesture {
  kind: string;
  config: Record<string, unknown>;
  onBegin?: (event: MockGestureEvent) => void;
  onStart?: (event: MockGestureEvent) => void;
  onUpdate?: (event: MockGestureEvent) => void;
  onEnd?: (event: MockGestureEvent) => void;
  onFinalize?: (event: MockGestureEvent) => void;
}

/** Every gesture built since the last reset, in construction order. */
export const mockGestures: MockGesture[] = [];

export function resetMockGestures(): void {
  mockGestures.length = 0;
}

/** Returns the most recently constructed gesture of the given kind. */
export function latestMockGesture(kind: string): MockGesture {
  for (let index = mockGestures.length - 1; index >= 0; index -= 1) {
    const gesture = mockGestures[index];
    if (gesture?.kind === kind) {
      return gesture;
    }
  }
  throw new Error(`No ${kind} gesture was constructed`);
}

/** Returns the most recently constructed gesture registered under the given `withTestId`. */
export function mockGestureByTestId(testId: string): MockGesture {
  for (let index = mockGestures.length - 1; index >= 0; index -= 1) {
    const gesture = mockGestures[index];
    if (gesture?.config['withTestId'] === testId) {
      return gesture;
    }
  }
  throw new Error(`No gesture with testId "${testId}" was constructed`);
}

/** Drives a gesture through the drag lifecycle so tests can assert on real swipe outcomes. */
export function simulatePan(
  gesture: MockGesture,
  steps: MockGestureEvent[],
  end: MockGestureEvent = {},
): void {
  gesture.onBegin?.(steps[0] ?? {});
  gesture.onStart?.(steps[0] ?? {});
  for (const step of steps) {
    gesture.onUpdate?.(step);
  }
  const last = steps[steps.length - 1] ?? {};
  gesture.onEnd?.({ ...last, ...end });
  gesture.onFinalize?.({ ...last, ...end });
}

function createGesture(kind: string): MockGesture {
  const record: MockGesture = { kind, config: {} };
  mockGestures.push(record);
  const proxy: unknown = new Proxy(record, {
    get:
      (target, property: string) =>
      (...args: unknown[]) => {
        if (property.startsWith('on') && typeof args[0] === 'function') {
          Object.assign(target, { [property]: args[0] });
        } else {
          target.config[property] = args.length === 1 ? args[0] : args;
        }
        return proxy;
      },
  });
  return proxy as MockGesture;
}

export const Gesture = {
  Pan: () => createGesture('Pan'),
  Tap: () => createGesture('Tap'),
  Pinch: () => createGesture('Pinch'),
  Native: () => createGesture('Native'),
  Simultaneous: (...gestures: unknown[]) => gestures[0],
  Exclusive: (...gestures: unknown[]) => gestures[0],
  Race: (...gestures: unknown[]) => gestures[0],
};

export function GestureDetector({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export const GestureHandlerRootView = View;
export const ScrollView = View;
