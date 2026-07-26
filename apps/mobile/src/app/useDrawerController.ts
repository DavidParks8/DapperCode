import { useCallback, useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import {
  DRAWER_MAX_ELEVATION,
  DRAWER_MAX_SHADOW_OPACITY,
  DRAWER_MAX_SHADOW_RADIUS,
} from './appConstants';
import { getDrawerOpenProgress } from './appDrawerUtils';
import { useDrawerGestures } from './useDrawerGestures';
import {
  drawerCapturesTouchesAtom,
  drawerCommandsAtom,
  drawerOpenAtom,
  drawerVisibleAtom,
  tabletSidebarVisibleAtom,
} from '../state/drawer/atoms';
import { currentScreenAtom, settingsAllowsDrawerGestureAtom } from '../state/navigation/atoms';

interface UseDrawerControllerArgs {
  usesTabletLayout: boolean;
  drawerWidth: number;
  onBackSwipe: () => void;
}

export function useDrawerController({
  usesTabletLayout,
  drawerWidth,
  onBackSwipe,
}: UseDrawerControllerArgs) {
  const store = useStore();
  const currentScreen = useAtomValue(currentScreenAtom);
  const settingsAllowsDrawerGesture = useAtomValue(settingsAllowsDrawerGestureAtom);
  const drawerVisible = useAtomValue(drawerVisibleAtom);
  const drawerCapturesTouches = useAtomValue(drawerCapturesTouchesAtom);
  const tabletSidebarVisible = useAtomValue(tabletSidebarVisibleAtom);
  const setDrawerCommands = useSetAtom(drawerCommandsAtom);
  const setTabletSidebarVisible = useSetAtom(tabletSidebarVisibleAtom);

  const contentShiftOpen = drawerWidth;
  const drawerOffset = useSharedValue(-drawerWidth);
  const drawerDragStartOffset = useSharedValue(-drawerWidth);
  const drawerGestureDidSettle = useSharedValue(true);

  const screenFrameAnimatedStyle = useAnimatedStyle(() => {
    if (usesTabletLayout) {
      return {
        transform: [{ translateX: 0 }],
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
      };
    }

    const progress = getDrawerOpenProgress(drawerOffset.value, drawerWidth);
    return {
      transform: [{ translateX: progress * contentShiftOpen }],
      shadowOpacity: DRAWER_MAX_SHADOW_OPACITY * progress,
      shadowRadius: DRAWER_MAX_SHADOW_RADIUS * progress,
      elevation: DRAWER_MAX_ELEVATION * progress,
    };
  }, [contentShiftOpen, drawerWidth, usesTabletLayout]);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: getDrawerOpenProgress(drawerOffset.value, drawerWidth),
  }));

  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drawerOffset.value }],
  }));

  const drawerContentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: 0.88 + getDrawerOpenProgress(drawerOffset.value, drawerWidth) * 0.12,
  }));

  useEffect(() => {
    const nextOffset = store.get(drawerOpenAtom) ? 0 : -drawerWidth;
    drawerOffset.value = nextOffset;
    drawerDragStartOffset.value = nextOffset;
  }, [drawerDragStartOffset, drawerOffset, drawerWidth, store]);

  const handleDrawerSettled = useCallback(
    (isOpen: boolean) => {
      store.set(drawerOpenAtom, isOpen);
      store.set(drawerVisibleAtom, isOpen);
      store.set(drawerCapturesTouchesAtom, isOpen);
    },
    [store]
  );

  const toggleTabletSidebar = useCallback(() => {
    setTabletSidebarVisible((visible) => !visible);
  }, [setTabletSidebarVisible]);

  const {
    closeDrawer,
    handleNavigationToggle,
    openDrawerGesture,
    visibleDrawerGesture,
    visibleDrawerTapGesture,
    backSwipeGesture,
  } = useDrawerGestures({
    currentScreen,
    usesTabletLayout,
    settingsAllowsDrawerGesture,
    drawerVisible,
    drawerWidth,
    drawerOffset,
    drawerDragStartOffset,
    drawerGestureDidSettle,
    onDrawerSettled: handleDrawerSettled,
    onToggleTabletSidebar: toggleTabletSidebar,
    onBackSwipe,
  });

  const drawerCommands = useMemo(
    () => ({ closeDrawer, toggleNavigation: handleNavigationToggle }),
    [closeDrawer, handleNavigationToggle]
  );

  useEffect(() => {
    setDrawerCommands(drawerCommands);
    return () => {
      setDrawerCommands(null);
    };
  }, [drawerCommands, setDrawerCommands]);

  useEffect(() => {
    if (!usesTabletLayout) {
      return;
    }

    handleDrawerSettled(false);
    drawerOffset.value = -drawerWidth;
    drawerDragStartOffset.value = -drawerWidth;
  }, [drawerDragStartOffset, drawerOffset, drawerWidth, handleDrawerSettled, usesTabletLayout]);

  return {
    drawerVisible,
    drawerCapturesTouches,
    tabletSidebarVisible,
    closeDrawer,
    handleNavigationToggle,
    openDrawerGesture,
    visibleDrawerGesture,
    visibleDrawerTapGesture,
    backSwipeGesture,
    screenFrameAnimatedStyle,
    overlayAnimatedStyle,
    drawerAnimatedStyle,
    drawerContentAnimatedStyle,
  };
}
