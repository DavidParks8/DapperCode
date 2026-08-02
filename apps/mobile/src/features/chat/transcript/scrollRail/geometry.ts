import type { ChatMessage } from '@bridge/types/types';
import { getToolCallDisplayLines } from '@bridge/messages';

export const CHAT_SCROLL_RAIL_ACTIVATION_DELAY_MS = 200;
export const CHAT_SCROLL_RAIL_BAR_HEIGHT = 4;
export const CHAT_SCROLL_RAIL_BAR_PITCH = 24;
export const CHAT_SCROLL_RAIL_COLLAPSED_WIDTH = 16;
export const CHAT_SCROLL_RAIL_COLLAPSED_ACTIVE_WIDTH = 21;
export const CHAT_SCROLL_RAIL_ENGAGED_MIN_WIDTH = 32;
export const CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH = 74;
export const CHAT_SCROLL_RAIL_FISHEYE_RADIUS = 78;
export const CHAT_SCROLL_RAIL_HORIZONTAL_PADDING = 12;
export const CHAT_SCROLL_RAIL_VERTICAL_PADDING = 28;
export const CHAT_SCROLL_RAIL_TOUCH_WIDTH = 44;
export const CHAT_SCROLL_RAIL_EDGE_ZONE = 42;
export const CHAT_SCROLL_RAIL_EDGE_TICK_MS = 120;
export const CHAT_SCROLL_RAIL_WINDOW_BUFFER = 2;
export const CHAT_SCROLL_RAIL_REVEAL_MARGIN = 6;

export interface UserMessageAnchor {
  messageId: string;
  transcriptIndex: number;
}

export interface RailRenderRange {
  start: number;
  end: number;
}

export function collectUserMessageAnchors(messages: readonly ChatMessage[]): UserMessageAnchor[] {
  const anchors: UserMessageAnchor[] = [];
  messages.forEach((message, transcriptIndex) => {
    // ACP approval and user-input responses are not projected as user messages. Until the protocol
    // carries explicit origin metadata, role=user is the transcript's user-initiation invariant.
    if (
      message.role === 'user' &&
      !message.toolMeta &&
      getToolCallDisplayLines(message).length === 0
    ) {
      anchors.push({ messageId: message.id, transcriptIndex });
    }
  });
  return anchors;
}

export function railWindowCapacity(viewportHeight: number): number {
  'worklet';
  const usableHeight = Math.max(0, viewportHeight - CHAT_SCROLL_RAIL_VERTICAL_PADDING * 2);
  return Math.max(1, Math.floor(usableHeight / CHAT_SCROLL_RAIL_BAR_PITCH) + 1);
}

export function clampRailWindowStart(
  windowStart: number,
  anchorCount: number,
  capacity: number,
): number {
  'worklet';
  const maxStart = Math.max(0, anchorCount - Math.max(1, capacity));
  return Math.min(maxStart, Math.max(0, Math.round(windowStart)));
}

export function centerRailWindowStart(
  activeIndex: number,
  anchorCount: number,
  capacity: number,
): number {
  'worklet';
  return clampRailWindowStart(
    activeIndex - Math.floor(Math.max(1, capacity) / 2),
    anchorCount,
    capacity,
  );
}

export function railTopInset(
  viewportHeight: number,
  anchorCount: number,
  capacity: number,
): number {
  'worklet';
  const visibleCount = Math.min(anchorCount, Math.max(1, capacity));
  const stackHeight =
    visibleCount <= 0
      ? 0
      : (visibleCount - 1) * CHAT_SCROLL_RAIL_BAR_PITCH + CHAT_SCROLL_RAIL_BAR_HEIGHT;
  return Math.max(CHAT_SCROLL_RAIL_VERTICAL_PADDING, (viewportHeight - stackHeight) / 2);
}

export function barIndexForFingerY(
  fingerY: number,
  railTop: number,
  windowStart: number,
  anchorCount: number,
  capacity: number,
): number {
  'worklet';
  if (anchorCount <= 0) {
    return -1;
  }
  const visibleCount = Math.min(anchorCount, Math.max(1, capacity));
  const slot = Math.min(
    visibleCount - 1,
    Math.max(0, Math.round((fingerY - railTop) / CHAT_SCROLL_RAIL_BAR_PITCH)),
  );
  return Math.min(anchorCount - 1, clampRailWindowStart(windowStart, anchorCount, capacity) + slot);
}

export function barCenterY(slot: number, railTop: number): number {
  'worklet';
  return railTop + slot * CHAT_SCROLL_RAIL_BAR_PITCH + CHAT_SCROLL_RAIL_BAR_HEIGHT / 2;
}

export function fisheyeBarWidth(distanceFromFinger: number): number {
  'worklet';
  const normalizedDistance = Math.min(
    1,
    Math.abs(distanceFromFinger) / CHAT_SCROLL_RAIL_FISHEYE_RADIUS,
  );
  const influence = (1 + Math.cos(normalizedDistance * Math.PI)) / 2;
  return (
    CHAT_SCROLL_RAIL_ENGAGED_MIN_WIDTH +
    (CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH - CHAT_SCROLL_RAIL_ENGAGED_MIN_WIDTH) * influence
  );
}

export function railRenderRange(
  windowStart: number,
  anchorCount: number,
  capacity: number,
  buffer = CHAT_SCROLL_RAIL_WINDOW_BUFFER,
): RailRenderRange {
  const clampedStart = clampRailWindowStart(windowStart, anchorCount, capacity);
  return {
    start: Math.max(0, clampedStart - buffer),
    end: Math.min(anchorCount, clampedStart + Math.max(1, capacity) + buffer),
  };
}

export function resolveActiveAnchorIndex(
  anchorDisplayIndices: readonly (number | null)[],
  visualTopDisplayIndex: number,
): number {
  let bestAnchorIndex = -1;
  let bestDisplayIndex = Number.POSITIVE_INFINITY;

  anchorDisplayIndices.forEach((displayIndex, anchorIndex) => {
    if (
      displayIndex !== null &&
      displayIndex >= visualTopDisplayIndex &&
      displayIndex < bestDisplayIndex
    ) {
      bestAnchorIndex = anchorIndex;
      bestDisplayIndex = displayIndex;
    }
  });

  if (bestAnchorIndex >= 0) {
    return bestAnchorIndex;
  }

  let oldestVisibleIndex = -1;
  let largestDisplayIndex = Number.NEGATIVE_INFINITY;
  anchorDisplayIndices.forEach((displayIndex, anchorIndex) => {
    if (displayIndex !== null && displayIndex > largestDisplayIndex) {
      oldestVisibleIndex = anchorIndex;
      largestDisplayIndex = displayIndex;
    }
  });
  return oldestVisibleIndex;
}
