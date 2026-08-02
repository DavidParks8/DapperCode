import {
  initialChatScrollRailState,
  transitionChatScrollRail,
  type ChatScrollRailState,
} from './chatScrollRailState';

describe('chat scroll rail state', () => {
  it('syncs the resting highlight and centers its window', () => {
    const result = transitionChatScrollRail(initialChatScrollRailState, {
      type: 'sync',
      anchorCount: 20,
      capacity: 7,
      preferredActiveIndex: 10,
    });

    expect(result).toEqual({
      state: { engaged: false, activeIndex: 10, windowStart: 7 },
      effect: null,
    });
  });

  it('engages at the finger, emits one impact, then ticks only across bars', () => {
    const resting: ChatScrollRailState = { engaged: false, activeIndex: 8, windowStart: 5 };
    const engaged = transitionChatScrollRail(resting, {
      type: 'engage',
      fingerY: 100,
      railTop: 52,
      anchorCount: 20,
      capacity: 8,
    });
    expect(engaged.state).toEqual({ engaged: true, activeIndex: 7, windowStart: 5 });
    expect(engaged.effect).toEqual({ haptic: 'impact', jumpIndex: 7 });

    const sameBar = transitionChatScrollRail(engaged.state, {
      type: 'move',
      fingerY: 102,
      railTop: 52,
      anchorCount: 20,
      capacity: 8,
    });
    expect(sameBar.effect).toBeNull();
    expect(sameBar.state).toBe(engaged.state);

    const nextBar = transitionChatScrollRail(sameBar.state, {
      type: 'move',
      fingerY: 126,
      railTop: 52,
      anchorCount: 20,
      capacity: 8,
    });
    expect(nextBar.effect).toEqual({ haptic: 'selection', jumpIndex: 8 });
  });

  it('pans overflowing windows one fixed bar at a time', () => {
    const engaged: ChatScrollRailState = { engaged: true, activeIndex: 12, windowStart: 8 };
    const next = transitionChatScrollRail(engaged, {
      type: 'edgeTick',
      direction: 1,
      anchorCount: 30,
      capacity: 8,
    });
    expect(next.state).toEqual({ engaged: true, activeIndex: 13, windowStart: 9 });
    expect(next.effect).toEqual({ haptic: 'selection', jumpIndex: 13 });

    const atStart = transitionChatScrollRail(
      { engaged: true, activeIndex: 0, windowStart: 0 },
      { type: 'edgeTick', direction: -1, anchorCount: 30, capacity: 8 },
    );
    expect(atStart.effect).toBeNull();

    const clampedWindow = transitionChatScrollRail(
      { engaged: true, activeIndex: 20, windowStart: 22 },
      { type: 'edgeTick', direction: 1, anchorCount: 30, capacity: 8 },
    );
    expect(clampedWindow.state).toEqual({
      engaged: true,
      activeIndex: 21,
      windowStart: 22,
    });
    expect(clampedWindow.effect).toEqual({ haptic: 'selection', jumpIndex: 21 });
  });

  it('rebases a held window when older anchors are prepended and resets cleanly', () => {
    const synced = transitionChatScrollRail(
      { engaged: true, activeIndex: 2, windowStart: 1 },
      { type: 'sync', anchorCount: 12, capacity: 5, preferredActiveIndex: 5 },
    );
    expect(synced.state).toEqual({ engaged: true, activeIndex: 5, windowStart: 4 });

    expect(transitionChatScrollRail(synced.state, { type: 'release' }).state.engaged).toBe(false);
    expect(transitionChatScrollRail(synced.state, { type: 'reset' }).state).toEqual(
      initialChatScrollRailState,
    );
  });

  it('does not engage when there are no user anchors', () => {
    const result = transitionChatScrollRail(initialChatScrollRailState, {
      type: 'engage',
      fingerY: 120,
      railTop: 20,
      anchorCount: 0,
      capacity: 8,
    });
    expect(result).toEqual({ state: initialChatScrollRailState, effect: null });

    const moveWithoutStart = transitionChatScrollRail(initialChatScrollRailState, {
      type: 'move',
      fingerY: 144,
      railTop: 20,
      anchorCount: 2,
      capacity: 8,
    });
    expect(moveWithoutStart).toEqual({ state: initialChatScrollRailState, effect: null });
  });

  it('returns the same state when transcript sync does not move the resting rail', () => {
    const resting: ChatScrollRailState = { engaged: false, activeIndex: 4, windowStart: 2 };
    const result = transitionChatScrollRail(resting, {
      type: 'sync',
      anchorCount: 10,
      capacity: 5,
      preferredActiveIndex: 4,
    });
    expect(result.state).toBe(resting);
  });
});
