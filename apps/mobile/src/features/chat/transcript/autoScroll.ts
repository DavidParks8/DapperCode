import { useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, type GestureResponderEvent } from 'react-native';

import type { AutoScrollState } from '../helpers/helpers';
import type { TranscriptDisplayItem } from './messages';

export const PINNED_SCROLL_EPSILON_PX = 1;

export function shouldRequestPinnedScroll(state: AutoScrollState, offset: number): boolean {
  return (
    offset > PINNED_SCROLL_EPSILON_PX && !state.isUserInteracting && !state.isMomentumScrolling
  );
}

export function updateAutoScrollStickiness(state: AutoScrollState, isNearBottom: boolean): boolean {
  if (state.isUserInteracting || isNearBottom) {
    state.shouldStickToBottom = isNearBottom;
  }
  return state.shouldStickToBottom;
}

export function getMaintainedScrollPosition(
  items: readonly TranscriptDisplayItem[],
  hasHeader: boolean,
  browsingHistory: boolean,
  isInteracting: boolean,
) {
  if (!browsingHistory && !isInteracting) {
    return undefined;
  }
  const userIndex = items.findIndex(
    (item) => item.kind === 'message' && item.message.role === 'user',
  );
  // Inverted cells grow toward their visual top. Anchor above the mutable turn, not its bottom.
  return { minIndexForVisible: (userIndex < 0 ? items.length : userIndex) + (hasHeader ? 1 : 0) };
}

export function useTranscriptScrollInteraction(
  chatId: string,
  stateRef: RefObject<AutoScrollState>,
  onInteractionStart: () => void,
) {
  const touchActiveRef = useRef(false);
  const dragActiveRef = useRef(false);
  const [isInteracting, setIsInteracting] = useState(false);
  useEffect(() => {
    touchActiveRef.current = false;
    dragActiveRef.current = false;
    setIsInteracting(false);
  }, [chatId]);

  const handleTouchEnd = (event: GestureResponderEvent) => {
    touchActiveRef.current = event.nativeEvent.touches.length > 0;
    stateRef.current.isUserInteracting =
      touchActiveRef.current || dragActiveRef.current || stateRef.current.isMomentumScrolling;
    setIsInteracting(stateRef.current.isUserInteracting);
  };
  return {
    isInteracting,
    onTouchStart: () => {
      touchActiveRef.current = true;
      stateRef.current.isUserInteracting = true;
      setIsInteracting(true);
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
      setIsInteracting(true);
    },
    onScrollEndDrag: () => {
      dragActiveRef.current = false;
      stateRef.current.isUserInteracting =
        touchActiveRef.current || stateRef.current.isMomentumScrolling;
      setIsInteracting(stateRef.current.isUserInteracting);
    },
    onMomentumScrollBegin: () => {
      stateRef.current.isMomentumScrolling = true;
      setIsInteracting(true);
    },
    onMomentumScrollEnd: () => {
      stateRef.current.isUserInteracting = touchActiveRef.current || dragActiveRef.current;
      stateRef.current.isMomentumScrolling = false;
      setIsInteracting(stateRef.current.isUserInteracting);
    },
  };
}
