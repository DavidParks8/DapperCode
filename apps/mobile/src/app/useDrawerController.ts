import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import {
  DRAWER_MAX_ELEVATION,
  DRAWER_MAX_SHADOW_OPACITY,
  DRAWER_MAX_SHADOW_RADIUS,
  type Screen,
} from './appConstants';
import {
  getDrawerOpenProgress,
} from './appDrawerUtils';
import { useDrawerGestures } from './useDrawerGestures';

interface UseDrawerControllerArgs {
  currentScreen: Screen;
  usesTabletLayout: boolean;
  drawerWidth: number;
  settingsAllowsDrawerGesture: boolean;
  onBackSwipe: () => void;
}

export function useDrawerController({
  currentScreen,
  usesTabletLayout,
  drawerWidth,
  settingsAllowsDrawerGesture,
  onBackSwipe,
}: UseDrawerControllerArgs) {
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerCapturesTouches, setDrawerCapturesTouches] = useState(false);
  const [tabletSidebarVisible, setTabletSidebarVisible] = useState(true);

  const drawerOpenRef = useRef(false);
  const drawerVisibleRef = useRef(false);
  const drawerCapturesTouchesRef = useRef(false);

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
    const nextOffset = drawerOpenRef.current ? 0 : -drawerWidth;
    drawerOffset.value = nextOffset;
    drawerDragStartOffset.value = nextOffset;
  }, [drawerDragStartOffset, drawerOffset, drawerWidth]);

  const handleDrawerSettled = useCallback((isOpen: boolean) => {
    drawerOpenRef.current = isOpen;
    drawerVisibleRef.current = isOpen;
    drawerCapturesTouchesRef.current = isOpen;
    setDrawerVisible(isOpen);
    setDrawerCapturesTouches(isOpen);
  }, []);

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
    drawerVisibleRef,
    drawerCapturesTouchesRef,
    setDrawerVisible,
    setDrawerCapturesTouches,
    onDrawerSettled: handleDrawerSettled,
    onToggleTabletSidebar: () => setTabletSidebarVisible((visible) => !visible),
    onBackSwipe,
  });

  useEffect(() => {
    if (!usesTabletLayout) {
      return;
    }

    handleDrawerSettled(false);
    drawerOffset.value = -drawerWidth;
    drawerDragStartOffset.value = -drawerWidth;
  }, [
    drawerDragStartOffset,
    drawerOffset,
    drawerWidth,
    handleDrawerSettled,
    usesTabletLayout,
  ]);

  return {
    drawerVisible,
    drawerCapturesTouches,
    tabletSidebarVisible,
    drawerOpenRef,
    drawerVisibleRef,
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
