import { useFocusEffect } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import {
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';

interface ChatAnimationClockContextValue {
  elapsedMs: SharedValue<number>;
  registerAnimation: () => () => void;
}

const ChatAnimationClockContext = createContext<ChatAnimationClockContextValue | null>(null);

export function ChatAnimationClockProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const elapsedMs = useSharedValue(0);
  const [activeAnimations, setActiveAnimations] = useState(0);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [focused, setFocused] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  const frameCallback = useFrameCallback(({ timeSincePreviousFrame }) => {
    'worklet';
    if (timeSincePreviousFrame != null) {
      elapsedMs.value += timeSincePreviousFrame;
    }
  }, false);
  const shouldRun = enabled && focused && appActive && activeAnimations > 0;

  useEffect(() => {
    frameCallback.setActive(shouldRun);
    return () => frameCallback.setActive(false);
  }, [frameCallback, shouldRun]);

  const registerAnimation = useCallback(() => {
    let registered = true;
    setActiveAnimations((count) => count + 1);
    return () => {
      if (!registered) {
        return;
      }
      registered = false;
      setActiveAnimations((count) => Math.max(0, count - 1));
    };
  }, []);
  const value = useMemo(() => ({ elapsedMs, registerAnimation }), [elapsedMs, registerAnimation]);

  return (
    <ChatAnimationClockContext.Provider value={value}>
      {children}
    </ChatAnimationClockContext.Provider>
  );
}

/**
 * Returns time spent actively animating on the focused, foreground chat surface. Consumers retain
 * their own start offset while sharing the provider's single frame callback.
 */
export function useChatAnimationTime(active: boolean): DerivedValue<number> {
  const context = useContext(ChatAnimationClockContext);
  const fallbackClock = useSharedValue(0);
  const clock = context?.elapsedMs ?? fallbackClock;
  const startedAtMs = useSharedValue(clock.value);

  useEffect(() => {
    if (!active || !context) {
      startedAtMs.value = clock.value;
      return undefined;
    }
    startedAtMs.value = clock.value;
    return context.registerAnimation();
  }, [active, clock, context, startedAtMs]);

  return useDerivedValue(
    () => (active ? Math.max(0, clock.value - startedAtMs.value) : 0),
    [active, clock, startedAtMs],
  );
}

export function repeatingProgress(elapsedMs: number, durationMs: number): number {
  'worklet';
  if (durationMs <= 0) {
    return 0;
  }
  return (elapsedMs % durationMs) / durationMs;
}

export function reversingProgress(elapsedMs: number, durationMs: number): number {
  'worklet';
  const progress = repeatingProgress(elapsedMs, durationMs * 2);
  return progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
}
