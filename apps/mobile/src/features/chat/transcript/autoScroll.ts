import { useEffect, useRef, type RefObject } from 'react';
import { Keyboard, type GestureResponderEvent } from 'react-native';

import type { AutoScrollState } from '../helpers/helpers';

export const PINNED_SCROLL_EPSILON_PX = 1;

export function updateAutoScrollStickiness(state: AutoScrollState, isNearBottom: boolean): boolean {
  if (state.isUserInteracting || isNearBottom) {
    state.shouldStickToBottom = isNearBottom;
  }
  return state.shouldStickToBottom;
}

export function useTranscriptScrollInteraction(
  chatId: string,
  stateRef: RefObject<AutoScrollState>,
  onInteractionStart: () => void,
) {
  const touchActiveRef = useRef(false);
  const dragActiveRef = useRef(false);
  useEffect(() => {
    touchActiveRef.current = false;
    dragActiveRef.current = false;
  }, [chatId]);

  const handleTouchEnd = (event: GestureResponderEvent) => {
    touchActiveRef.current = event.nativeEvent.touches.length > 0;
    stateRef.current.isUserInteracting =
      touchActiveRef.current || dragActiveRef.current || stateRef.current.isMomentumScrolling;
  };
  return {
    onTouchStart: () => {
      touchActiveRef.current = true;
      stateRef.current.isUserInteracting = true;
      onInteractionStart();
    },
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchEnd,
    onScrollBeginDrag: () => {
      dragActiveRef.current = true;
      onInteractionStart();
      Keyboard.dismiss();
      stateRef.current.isUserInteracting = true;
      stateRef.current.isMomentumScrolling = false;
      stateRef.current.shouldStickToBottom = false;
    },
    onScrollEndDrag: () => {
      dragActiveRef.current = false;
      stateRef.current.isUserInteracting =
        touchActiveRef.current || stateRef.current.isMomentumScrolling;
    },
    onMomentumScrollBegin: () => {
      stateRef.current.isMomentumScrolling = true;
    },
    onMomentumScrollEnd: () => {
      stateRef.current.isUserInteracting = touchActiveRef.current || dragActiveRef.current;
      stateRef.current.isMomentumScrolling = false;
    },
  };
}
