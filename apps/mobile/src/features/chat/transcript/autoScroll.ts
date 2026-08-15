import type { AutoScrollState } from '../helpers/helpers';

export const PINNED_SCROLL_EPSILON_PX = 1;

export function updateAutoScrollStickiness(state: AutoScrollState, isNearBottom: boolean): boolean {
  if (state.isUserInteracting || isNearBottom) {
    state.shouldStickToBottom = isNearBottom;
  }
  return state.shouldStickToBottom;
}
