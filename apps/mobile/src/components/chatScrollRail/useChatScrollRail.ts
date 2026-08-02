import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { useReducedMotion, useSharedValue } from 'react-native-reanimated';

import { playLightImpact, playSelectionTick } from '../../haptics';
import { animateRailEngagement } from './ChatScrollRail';
import {
  CHAT_SCROLL_RAIL_ACTIVATION_DELAY_MS,
  CHAT_SCROLL_RAIL_BAR_PITCH,
  CHAT_SCROLL_RAIL_EDGE_TICK_MS,
  CHAT_SCROLL_RAIL_EDGE_ZONE,
  CHAT_SCROLL_RAIL_TOUCH_WIDTH,
  railTopInset,
  type UserMessageAnchor,
} from './chatScrollRailGeometry';
import {
  initialChatScrollRailState,
  transitionChatScrollRail,
  type ChatScrollRailEvent,
  type ChatScrollRailState,
} from './chatScrollRailState';

export interface UseChatScrollRailOptions {
  enabled?: boolean;
  resetKey: string;
  anchors: readonly UserMessageAnchor[];
  capacity: number;
  viewportHeight: number;
  restingActiveIndex: number;
  onJumpToAnchor: (anchor: UserMessageAnchor) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
  onReachStart?: () => void;
}

export interface UseChatScrollRailResult {
  state: ChatScrollRailState;
  gesture: ReturnType<typeof Gesture.Pan>;
  engaged: ReturnType<typeof useSharedValue<number>>;
  fingerY: ReturnType<typeof useSharedValue<number>>;
  scrollEnabled: boolean;
}

export function useChatScrollRail({
  enabled = true,
  resetKey,
  anchors,
  capacity,
  viewportHeight,
  restingActiveIndex,
  onJumpToAnchor,
  onInteractionStart,
  onInteractionEnd,
  onReachStart,
}: UseChatScrollRailOptions): UseChatScrollRailResult {
  const reduceMotion = useReducedMotion();
  const engaged = useSharedValue(0);
  const fingerY = useSharedValue(0);
  const [state, setState] = useState(initialChatScrollRailState);
  const stateRef = useRef(state);
  const anchorsRef = useRef(anchors);
  const selectedAnchorIdRef = useRef<string | null>(null);
  const edgeDirectionRef = useRef<-1 | 0 | 1>(0);
  const edgeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reachedStartRef = useRef(false);
  const resetKeyRef = useRef(resetKey);
  const tickEdgeRef = useRef<(direction: -1 | 1) => void>(() => {});

  stateRef.current = state;
  anchorsRef.current = anchors;

  const applyTransition = useCallback(
    (event: ChatScrollRailEvent) => {
      const transition = transitionChatScrollRail(stateRef.current, event);
      stateRef.current = transition.state;
      setState(transition.state);
      if (!transition.effect) {
        return;
      }
      const anchor = anchorsRef.current[transition.effect.jumpIndex];
      if (!anchor) {
        return;
      }
      selectedAnchorIdRef.current = anchor.messageId;
      if (transition.effect.haptic === 'impact') {
        playLightImpact();
      } else {
        playSelectionTick();
      }
      onJumpToAnchor(anchor);
    },
    [onJumpToAnchor],
  );

  const clearEdgeTimer = useCallback(() => {
    if (edgeTimerRef.current !== null) {
      clearInterval(edgeTimerRef.current);
      edgeTimerRef.current = null;
    }
    edgeDirectionRef.current = 0;
  }, []);

  const tickEdge = useCallback(
    (direction: -1 | 1) => {
      if (direction === -1 && stateRef.current.activeIndex <= 0) {
        if (!reachedStartRef.current) {
          reachedStartRef.current = true;
          onReachStart?.();
        }
        return;
      }
      reachedStartRef.current = false;
      applyTransition({
        type: 'edgeTick',
        direction,
        anchorCount: anchorsRef.current.length,
        capacity,
      });
    },
    [applyTransition, capacity, onReachStart],
  );

  const updateEdgeTimer = useCallback(
    (y: number) => {
      if (anchorsRef.current.length <= capacity) {
        clearEdgeTimer();
        return;
      }
      const top = railTopInset(viewportHeight, anchorsRef.current.length, capacity);
      const visibleCount = Math.min(anchorsRef.current.length, capacity);
      const bottom = top + Math.max(0, visibleCount - 1) * CHAT_SCROLL_RAIL_BAR_PITCH;
      const direction: -1 | 0 | 1 =
        y <= top + CHAT_SCROLL_RAIL_EDGE_ZONE
          ? -1
          : y >= bottom - CHAT_SCROLL_RAIL_EDGE_ZONE
            ? 1
            : 0;
      if (direction === edgeDirectionRef.current) {
        return;
      }
      clearEdgeTimer();
      edgeDirectionRef.current = direction;
      if (direction !== 0) {
        edgeTimerRef.current = setInterval(
          () => tickEdgeRef.current(direction),
          CHAT_SCROLL_RAIL_EDGE_TICK_MS,
        );
      }
    },
    [capacity, clearEdgeTimer, viewportHeight],
  );

  const begin = useCallback(
    (y: number) => {
      if (!enabled || anchorsRef.current.length === 0) {
        return;
      }
      onInteractionStart();
      animateRailEngagement(engaged, 1, reduceMotion);
      fingerY.value = y;
      const top = railTopInset(viewportHeight, anchorsRef.current.length, capacity);
      applyTransition({
        type: 'engage',
        fingerY: y,
        railTop: top,
        anchorCount: anchorsRef.current.length,
        capacity,
      });
      updateEdgeTimer(y);
    },
    [
      applyTransition,
      capacity,
      enabled,
      engaged,
      fingerY,
      onInteractionStart,
      reduceMotion,
      updateEdgeTimer,
      viewportHeight,
    ],
  );

  const move = useCallback(
    (y: number) => {
      if (!stateRef.current.engaged) {
        return;
      }
      fingerY.value = y;
      const top = railTopInset(viewportHeight, anchorsRef.current.length, capacity);
      applyTransition({
        type: 'move',
        fingerY: y,
        railTop: top,
        anchorCount: anchorsRef.current.length,
        capacity,
      });
      updateEdgeTimer(y);
    },
    [applyTransition, capacity, fingerY, updateEdgeTimer, viewportHeight],
  );

  const finish = useCallback(() => {
    if (!stateRef.current.engaged) {
      return;
    }
    clearEdgeTimer();
    animateRailEngagement(engaged, 0, reduceMotion);
    applyTransition({ type: 'release' });
    onInteractionEnd();
  }, [applyTransition, clearEdgeTimer, engaged, onInteractionEnd, reduceMotion]);

  tickEdgeRef.current = tickEdge;

  useEffect(() => {
    if (resetKeyRef.current === resetKey && enabled) {
      return;
    }
    resetKeyRef.current = resetKey;
    clearEdgeTimer();
    if (stateRef.current.engaged) {
      onInteractionEnd();
    }
    engaged.value = 0;
    stateRef.current = initialChatScrollRailState;
    setState(initialChatScrollRailState);
    selectedAnchorIdRef.current = null;
    reachedStartRef.current = false;
  }, [clearEdgeTimer, enabled, engaged, onInteractionEnd, resetKey]);

  useEffect(() => {
    const preservedIndex =
      stateRef.current.engaged && selectedAnchorIdRef.current
        ? anchors.findIndex((anchor) => anchor.messageId === selectedAnchorIdRef.current)
        : -1;
    applyTransition({
      type: 'sync',
      anchorCount: anchors.length,
      capacity,
      preferredActiveIndex: preservedIndex >= 0 ? preservedIndex : restingActiveIndex,
    });
    if (anchors.length > 0 && stateRef.current.activeIndex >= 0) {
      selectedAnchorIdRef.current = anchors[stateRef.current.activeIndex]?.messageId ?? null;
    }
  }, [anchors, applyTransition, capacity, restingActiveIndex]);

  useEffect(
    () => () => {
      clearEdgeTimer();
      if (stateRef.current.engaged) {
        onInteractionEnd();
      }
    },
    [clearEdgeTimer, onInteractionEnd],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .hitSlop({ width: CHAT_SCROLL_RAIL_TOUCH_WIDTH, right: 0 })
        .activateAfterLongPress(CHAT_SCROLL_RAIL_ACTIVATION_DELAY_MS)
        .maxPointers(1)
        .runOnJS(true)
        .withTestId('chat-scroll-rail-pan')
        .onStart((event) => {
          begin(event.y);
        })
        .onUpdate((event) => {
          move(event.y);
        })
        .onFinalize(() => {
          finish();
        }),
    [begin, enabled, finish, move],
  );

  return {
    state,
    gesture,
    engaged,
    fingerY,
    scrollEnabled: !state.engaged,
  };
}
