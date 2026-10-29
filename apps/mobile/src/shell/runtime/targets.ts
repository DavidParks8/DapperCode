export type ExecutionTarget = 'bridge' | 'on-device';

export function preferredTargetRoute(preferred: ExecutionTarget, desktop: Href): Href {
  return preferred === 'on-device' ? '/on-device' : desktop;
}

export function executionTargetForRoute(
  pathname: string,
  preferred: ExecutionTarget,
): ExecutionTarget {
  if (pathname === '/on-device' || pathname.startsWith('/on-device/')) {
    return 'on-device';
  }
  if (pathname.startsWith('/profiles/')) {
    return 'bridge';
  }
  return preferred;
}
import type { Href } from 'expo-router';
