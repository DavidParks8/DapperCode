import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import {
  DRAWER_CONTENT_PARALLAX,
  DRAWER_CONTENT_SCALE,
  DRAWER_MAX_ELEVATION,
  DRAWER_MAX_RADIUS,
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
  screenWidth: number;
  settingsAllowsDrawerGesture: boolean;
  onChatGitBack: () => void;
}

export function useDrawerController({
  currentScreen,
  usesTabletLayout,
  drawerWidth,
  screenWidth,
  settingsAllowsDrawerGesture,
  onChatGitBack,
}: UseDrawerControllerArgs) {
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerCapturesTouches, setDrawerCapturesTouches] = useState(false);
  const [tabletSidebarVisible, setTabletSidebarVisible] = useState(true);

  const drawerOpenRef = useRef(false);
  const drawerVisibleRef = useRef(false);
  const drawerCapturesTouchesRef = useRef(false);

  const contentShiftOpen = Math.min(drawerWidth - 12, screenWidth * 0.74);
  const drawerOffset = useSharedValue(-drawerWidth);
  const drawerDragStartOffset = useSharedValue(-drawerWidth);
  const drawerGestureDidSettle = useSharedValue(true);

  const screenFrameAnimatedStyle = useAnimatedStyle(() => {
    if (usesTabletLayout) {
      return {
        transform: [{ translateX: 0 }, { scale: 1 }],
        borderRadius: 0,
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
      };
    }

    const progress = getDrawerOpenProgress(drawerOffset.value, drawerWidth);
    return {
      transform: [
        { translateX: progress * contentShiftOpen },
        { scale: 1 - (1 - DRAWER_CONTENT_SCALE) * progress },
      ],
      borderRadius: DRAWER_MAX_RADIUS * progress,
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

  const drawerContentAnimatedStyle = useAnimatedStyle(() => {
    const progress = getDrawerOpenProgress(drawerOffset.value, drawerWidth);
    return {
      opacity: 0.88 + progress * 0.12,
      transform: [
        { translateX: (1 - progress) * -DRAWER_CONTENT_PARALLAX },
        { scale: 0.985 + progress * 0.015 },
      ],
    };
  });

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
    chatGitBackGesture,
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
    onChatGitBack,
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
    chatGitBackGesture,
    screenFrameAnimatedStyle,
    overlayAnimatedStyle,
    drawerAnimatedStyle,
    drawerContentAnimatedStyle,
  };
}
