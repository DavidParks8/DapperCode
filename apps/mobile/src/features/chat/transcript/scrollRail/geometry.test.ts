import type { ChatMessage } from '@bridge/types/types';
import {
  CHAT_SCROLL_RAIL_BAR_PITCH,
  CHAT_SCROLL_RAIL_COLLAPSED_WIDTH,
  CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH,
  CHAT_SCROLL_RAIL_ENGAGED_MIN_WIDTH,
  CHAT_SCROLL_RAIL_VERTICAL_PADDING,
  barCenterY,
  barIndexForFingerY,
  centerRailWindowStart,
  clampRailWindowStart,
  collectUserMessageAnchors,
  fisheyeBarWidth,
  railRenderRange,
  railTopInset,
  railWindowCapacity,
  resolveActiveAnchorIndex,
} from './geometry';

describe('chat scroll rail geometry', () => {
  it('collects only projected user messages as stable anchors', () => {
    const messages: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: 'First', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'approval', role: 'system', content: 'Approved', createdAt: '2026-08-01T00:00:01Z' },
      { id: 'assistant', role: 'assistant', content: 'Done', createdAt: '2026-08-01T00:00:02Z' },
      {
        id: 'synthetic-user-tool',
        role: 'user',
        content: 'Synthetic',
        createdAt: '2026-08-01T00:00:02Z',
        toolMeta: {
          toolCallId: 'synthetic',
          kind: 'other',
          status: 'completed',
          title: 'Synthetic',
        },
      },
      { id: 'user-2', role: 'user', content: 'Second', createdAt: '2026-08-01T00:00:03Z' },
    ];

    expect(collectUserMessageAnchors(messages)).toEqual([
      { messageId: 'user-1', transcriptIndex: 0 },
      { messageId: 'user-2', transcriptIndex: 4 },
    ]);
  });

  it('uses fixed pitch and clamps centered windows', () => {
    expect(railWindowCapacity(200)).toBe(
      Math.floor((200 - CHAT_SCROLL_RAIL_VERTICAL_PADDING * 2) / CHAT_SCROLL_RAIL_BAR_PITCH) + 1,
    );
    expect(railWindowCapacity(0)).toBe(1);
    expect(clampRailWindowStart(-5, 20, 7)).toBe(0);
    expect(clampRailWindowStart(99, 20, 7)).toBe(13);
    expect(centerRailWindowStart(10, 20, 7)).toBe(7);
    expect(centerRailWindowStart(19, 20, 7)).toBe(13);
  });

  it('centers short rails and maps finger positions into the current window', () => {
    const top = railTopInset(300, 4, 11);
    expect(top).toBeGreaterThan(CHAT_SCROLL_RAIL_VERTICAL_PADDING);
    expect(barCenterY(1, top) - barCenterY(0, top)).toBe(CHAT_SCROLL_RAIL_BAR_PITCH);
    expect(barIndexForFingerY(top, top, 5, 20, 8)).toBe(5);
    expect(barIndexForFingerY(top + CHAT_SCROLL_RAIL_BAR_PITCH * 3, top, 5, 20, 8)).toBe(8);
    expect(barIndexForFingerY(-100, top, 5, 20, 8)).toBe(5);
    expect(barIndexForFingerY(1000, top, 5, 20, 8)).toBe(12);
    expect(barIndexForFingerY(10, top, 0, 0, 8)).toBe(-1);
  });

  it('produces a smooth bounded fisheye falloff', () => {
    const atFinger = fisheyeBarWidth(0);
    const nearby = fisheyeBarWidth(CHAT_SCROLL_RAIL_BAR_PITCH);
    const distant = fisheyeBarWidth(1000);

    expect(atFinger).toBe(CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH);
    expect(nearby).toBeLessThan(atFinger);
    expect(nearby).toBeGreaterThan(CHAT_SCROLL_RAIL_ENGAGED_MIN_WIDTH);
    expect(distant).toBe(CHAT_SCROLL_RAIL_ENGAGED_MIN_WIDTH);
    expect(distant).toBeGreaterThan(CHAT_SCROLL_RAIL_COLLAPSED_WIDTH);
  });

  it('buffers the rendered range without exceeding anchor bounds', () => {
    expect(railRenderRange(10, 30, 8)).toEqual({ start: 8, end: 20 });
    expect(railRenderRange(0, 3, 8)).toEqual({ start: 0, end: 3 });
    expect(railRenderRange(99, 30, 8)).toEqual({ start: 20, end: 30 });
  });

  it('resolves the anchor at or immediately older than the visual top', () => {
    // Anchor order is chronological; display indices are reversed by the inverted list.
    expect(resolveActiveAnchorIndex([9, 6, 3, 0], 5)).toBe(1);
    expect(resolveActiveAnchorIndex([9, null, 3, 0], 5)).toBe(0);
    expect(resolveActiveAnchorIndex([9, 6, 3, 0], 12)).toBe(0);
    expect(resolveActiveAnchorIndex([null, null], 0)).toBe(-1);
  });
});
