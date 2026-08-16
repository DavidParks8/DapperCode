import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

export interface DrawerForegroundNavigation {
  openDrawer: () => void;
}

/**
 * After iOS lock/unlock, the drawer navigator can report `closed` while the native
 * panel is still on screen. Only then do we re-assert `open` on foreground, so a
 * later session tap can close the list without flashing an already-open drawer.
 */
export function useDrawerForegroundSync(
  navigation: DrawerForegroundNavigation | null,
  drawerStatus: 'open' | 'closed',
): void {
  const wasOpenRef = useRef(drawerStatus === 'open');

  useEffect(() => {
    if (drawerStatus === 'open') {
      wasOpenRef.current = true;
      return;
    }
    if (AppState.currentState === 'active') {
      wasOpenRef.current = false;
    }
  }, [drawerStatus]);

  useEffect(() => {
    if (!navigation) {
      return;
    }

    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        if (drawerStatus === 'open') {
          wasOpenRef.current = true;
        }
        return;
      }
      if (wasOpenRef.current && drawerStatus === 'closed') {
        navigation.openDrawer();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [drawerStatus, navigation]);
}
