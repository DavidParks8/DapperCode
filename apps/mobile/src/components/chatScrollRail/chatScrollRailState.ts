import {
  barIndexForFingerY,
  centerRailWindowStart,
  clampRailWindowStart,
} from './chatScrollRailGeometry';

export interface ChatScrollRailState {
  engaged: boolean;
  activeIndex: number;
  windowStart: number;
}

export type ChatScrollRailEvent =
  | {
      type: 'sync';
      anchorCount: number;
      capacity: number;
      preferredActiveIndex: number;
    }
  | {
      type: 'engage' | 'move';
      fingerY: number;
      railTop: number;
      anchorCount: number;
      capacity: number;
    }
  | {
      type: 'edgeTick';
      direction: -1 | 1;
      anchorCount: number;
      capacity: number;
    }
  | { type: 'release' }
  | { type: 'reset' };

export interface ChatScrollRailEffect {
  haptic: 'impact' | 'selection';
  jumpIndex: number;
}

export interface ChatScrollRailTransition {
  state: ChatScrollRailState;
  effect: ChatScrollRailEffect | null;
}

export const initialChatScrollRailState: ChatScrollRailState = {
  engaged: false,
  activeIndex: -1,
  windowStart: 0,
};

export function transitionChatScrollRail(
  state: ChatScrollRailState,
  event: ChatScrollRailEvent,
): ChatScrollRailTransition {
  if (event.type === 'reset') {
    return { state: initialChatScrollRailState, effect: null };
  }
  if (event.type === 'release') {
    return { state: { ...state, engaged: false }, effect: null };
  }
  if (event.type === 'sync') {
    if (event.anchorCount <= 0) {
      return { state: initialChatScrollRailState, effect: null };
    }
    const activeIndex = Math.min(
      event.anchorCount - 1,
      Math.max(0, event.preferredActiveIndex >= 0 ? event.preferredActiveIndex : state.activeIndex),
    );
    const windowStart = state.engaged
      ? clampRailWindowStart(
          state.windowStart + activeIndex - state.activeIndex,
          event.anchorCount,
          event.capacity,
        )
      : centerRailWindowStart(activeIndex, event.anchorCount, event.capacity);
    if (activeIndex === state.activeIndex && windowStart === state.windowStart) {
      return { state, effect: null };
    }
    return { state: { ...state, activeIndex, windowStart }, effect: null };
  }
  if (event.type === 'edgeTick') {
    if (!state.engaged || event.anchorCount <= 0) {
      return { state, effect: null };
    }
    const windowStart = clampRailWindowStart(
      state.windowStart + event.direction,
      event.anchorCount,
      event.capacity,
    );
    const activeIndex = Math.min(
      event.anchorCount - 1,
      Math.max(0, state.activeIndex + event.direction),
    );
    if (windowStart === state.windowStart && activeIndex === state.activeIndex) {
      return { state, effect: null };
    }
    return {
      state: { ...state, windowStart, activeIndex },
      effect: { haptic: 'selection', jumpIndex: activeIndex },
    };
  }

  const activeIndex = barIndexForFingerY(
    event.fingerY,
    event.railTop,
    state.windowStart,
    event.anchorCount,
    event.capacity,
  );
  if (event.type === 'engage' && event.anchorCount <= 0) {
    return { state, effect: null };
  }
  if (event.type === 'move' && !state.engaged) {
    return { state, effect: null };
  }
  const engaged = true;
  if (activeIndex < 0) {
    return { state: { ...state, engaged }, effect: null };
  }
  if (event.type === 'move' && activeIndex === state.activeIndex) {
    return { state, effect: null };
  }
  return {
    state: { ...state, engaged, activeIndex },
    effect: {
      haptic: event.type === 'engage' ? 'impact' : 'selection',
      jumpIndex: activeIndex,
    },
  };
}
