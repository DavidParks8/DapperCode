import {
  DRAWER_MIN_WIDTH,
  DRAWER_RUBBER_BAND_STRENGTH,
  DRAWER_SNAP_OPEN_PROGRESS,
  DRAWER_SNAP_VELOCITY,
  DRAWER_VELOCITY_PROJECTION,
} from './appConstants';

export function normalizeBridgeToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getDrawerWidth(screenWidth: number): number {
  return Math.max(DRAWER_MIN_WIDTH, screenWidth);
}

export function clampDrawerOffset(value: number, drawerWidth: number): number {
  'worklet';
  return Math.max(-drawerWidth, Math.min(0, value));
}

export function getDrawerOpenProgress(value: number, drawerWidth: number): number {
  'worklet';
  return (clampDrawerOffset(value, drawerWidth) + drawerWidth) / drawerWidth;
}

export function applyDrawerRubberBand(value: number, drawerWidth: number): number {
  'worklet';
  if (value > 0) {
    return value * DRAWER_RUBBER_BAND_STRENGTH;
  }

  if (value < -drawerWidth) {
    return -drawerWidth + (value + drawerWidth) * DRAWER_RUBBER_BAND_STRENGTH;
  }

  return value;
}

export function projectDrawerOffset(value: number, velocityX: number, drawerWidth: number): number {
  'worklet';
  return clampDrawerOffset(value + velocityX * DRAWER_VELOCITY_PROJECTION, drawerWidth);
}

export function shouldSettleDrawerOpen(
  value: number,
  velocityX: number,
  drawerWidth: number,
  startOffset: number
): boolean {
  'worklet';
  if (velocityX >= DRAWER_SNAP_VELOCITY) {
    return true;
  }

  if (velocityX <= -DRAWER_SNAP_VELOCITY) {
    return false;
  }

  const projectedProgress = getDrawerOpenProgress(
    projectDrawerOffset(value, velocityX, drawerWidth),
    drawerWidth
  );
  const startedOpen = getDrawerOpenProgress(startOffset, drawerWidth) > 0.5;
  const settleThreshold = startedOpen
    ? 1 - DRAWER_SNAP_OPEN_PROGRESS
    : DRAWER_SNAP_OPEN_PROGRESS;

  return projectedProgress >= settleThreshold;
}

export function buildDrawerSpringConfig(velocityX: number) {
  'worklet';
  return {
    damping: 22,
    stiffness: 260,
    mass: 0.9,
    velocity: Math.max(-1800, Math.min(1800, velocityX)),
  };
}