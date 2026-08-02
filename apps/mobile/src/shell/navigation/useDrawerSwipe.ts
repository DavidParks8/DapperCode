import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback } from 'react';

interface DrawerOptionsNavigation {
  setOptions: (options: { swipeEnabled: boolean }) => void;
}

const disabledRouteCounts = new WeakMap<DrawerOptionsNavigation, number>();

export function useDisableDrawerSwipe(): void {
  const drawerNavigation = useNavigation<DrawerOptionsNavigation>('/profiles/[profileId]/(drawer)');

  useFocusEffect(
    useCallback(() => {
      const nextCount = (disabledRouteCounts.get(drawerNavigation) ?? 0) + 1;
      disabledRouteCounts.set(drawerNavigation, nextCount);
      drawerNavigation.setOptions({ swipeEnabled: false });
      return () => {
        const remaining = Math.max(0, (disabledRouteCounts.get(drawerNavigation) ?? 1) - 1);
        if (remaining === 0) {
          disabledRouteCounts.delete(drawerNavigation);
          drawerNavigation.setOptions({ swipeEnabled: true });
        } else {
          disabledRouteCounts.set(drawerNavigation, remaining);
          drawerNavigation.setOptions({ swipeEnabled: false });
        }
      };
    }, [drawerNavigation]),
  );
}
