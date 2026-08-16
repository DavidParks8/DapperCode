import type { AppStateStatus } from 'react-native';

export function isUserPresentAppState(state: AppStateStatus): boolean {
  return state === 'active' || state === 'inactive';
}

export function supportsNativePushPresence(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}
