import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  cancelAnimation,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import {
  DRAWER_MAX_ELEVATION,
  DRAWER_MAX_SHADOW_OPACITY,
  DRAWER_MAX_SHADOW_RADIUS,
} from './appConstants';
import { buildDrawerSpringConfig, getDrawerOpenProgress } from './appDrawerUtils';
import { useDrawerGestures } from './useDrawerGestures';
import {
  drawerCapturesTouchesAtom,
  drawerCommandsAtom,
  drawerOpenAtom,
  drawerVisibleAtom,
  tabletSidebarVisibleAtom,
} from '../state/drawer/atoms';
import {
  currentScreenAtom,
  navigationCanGoBackAtom,
  navigationStackAtom,
  screenNavigationCommandsAtom,
  settingsAllowsDrawerGestureAtom,
} from '../state/navigation/atoms';

interface UseDrawerControllerArgs {
  usesTabletLayout: boolean;
  screenWidth: number;
  drawerWidth: number;
  onBackSwipe: () => void;
}

export function useDrawerController({
  usesTabletLayout,
  screenWidth,
  drawerWidth,
  onBackSwipe,
}: UseDrawerControllerArgs) {
  const store = useStore();
  const currentScreen = useAtomValue(currentScreenAtom);
  const settingsAllowsDrawerGesture = useAtomValue(settingsAllowsDrawerGestureAtom);
  const drawerVisible = useAtomValue(drawerVisibleAtom);
  const drawerCapturesTouches = useAtomValue(drawerCapturesTouchesAtom);
  const tabletSidebarVisible = useAtomValue(tabletSidebarVisibleAtom);
  const navigationCanGoBack = useAtomValue(navigationCanGoBackAtom);
  const navigationStack = useAtomValue(navigationStackAtom);
  const setDrawerCommands = useSetAtom(drawerCommandsAtom);
  const setScreenNavigationCommands = useSetAtom(screenNavigationCommandsAtom);
  const setTabletSidebarVisible = useSetAtom(tabletSidebarVisibleAtom);

  const contentShiftOpen = drawerWidth;
  const drawerOffset = useSharedValue(-drawerWidth);
  const drawerDragStartOffset = useSharedValue(-drawerWidth);
  const drawerGestureDidSettle = useSharedValue(true);
  const backSwipeOffset = useSharedValue(0);
  const backSwipeDragStartOffset = useSharedValue(0);
  const backSwipeGestureDidSettle = useSharedValue(true);

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

  const backSwipePushedScreenAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: backSwipeOffset.value }],
  }));

  const backSwipeUnderlayAnimatedStyle = useAnimatedStyle(() => {
    const width = Math.max(screenWidth, 1);
    const progress = Math.max(0, Math.min(1, backSwipeOffset.value / width));
    const underlayStartOffset = Math.min(width * 0.22, 88);
    return {
      transform: [{ translateX: -underlayStartOffset * (1 - progress) }],
    };
  }, [screenWidth]);

  useEffect(() => {
    const nextOffset = store.get(drawerOpenAtom) ? 0 : -drawerWidth;
    drawerOffset.value = nextOffset;
    drawerDragStartOffset.value = nextOffset;
  }, [drawerDragStartOffset, drawerOffset, drawerWidth, store]);

  // Track the previous stack length to distinguish pushes (animate in) from pops/resets (snap).
  const previousStackLengthRef = useRef(navigationStack.length);
  useEffect(() => {
    const prevLength = previousStackLengthRef.current;
    const nextLength = navigationStack.length;
    previousStackLengthRef.current = nextLength;

    const topRoute = navigationStack[nextLength - 1];
    const isPush = nextLength > prevLength;
    // SubAgent content is rendered by MainScreen; skip the slide-in animation for it.
    const isAnimatedPush = isPush && nextLength > 1 && topRoute?.screen !== 'SubAgent';

    if (isAnimatedPush) {
      cancelAnimation(backSwipeOffset);
      backSwipeGestureDidSettle.value = false;
      backSwipeOffset.value = screenWidth;
      backSwipeDragStartOffset.value = 0;
      backSwipeOffset.value = withSpring(
        0,
        { ...buildDrawerSpringConfig(0), overshootClamping: true, reduceMotion: ReduceMotion.System },
        (finished) => {
          if (finished) {
            backSwipeGestureDidSettle.value = true;
          }
        },
      );
    } else {
      cancelAnimation(backSwipeOffset);
      backSwipeOffset.value = 0;
      backSwipeDragStartOffset.value = 0;
      backSwipeGestureDidSettle.value = true;
    }
  }, [
    backSwipeDragStartOffset,
    backSwipeGestureDidSettle,
    backSwipeOffset,
    navigationStack,
    screenWidth,
  ]);

  const handleDrawerSettled = useCallback(
    (isOpen: boolean) => {
      store.set(drawerOpenAtom, isOpen);
      store.set(drawerVisibleAtom, isOpen);
      store.set(drawerCapturesTouchesAtom, isOpen);
    },
    [store],
  );

  /**
   * Triggers the same slide-out animation as the edge-swipe gesture, then calls `onBackSwipe`
   * (the pure-pop callback) once the spring settles.  Used by the hardware-back handler so that
   * programmatic pops look identical to gesture-driven pops.
   */
  const animateThenPop = useCallback(() => {
    cancelAnimation(backSwipeOffset);
    backSwipeDragStartOffset.value = 0;
    backSwipeGestureDidSettle.value = false;
    backSwipeOffset.value = withSpring(
      screenWidth,
      { ...buildDrawerSpringConfig(0), overshootClamping: true, reduceMotion: ReduceMotion.System },
      (finished) => {
        if (finished) {
          backSwipeGestureDidSettle.value = true;
          // Reset before the navigation state change so the next screen renders at offset 0.
          backSwipeOffset.value = 0;
          runOnJS(onBackSwipe)();
        }
      },
    );
  }, [backSwipeDragStartOffset, backSwipeGestureDidSettle, backSwipeOffset, onBackSwipe, screenWidth]);

  useEffect(() => {
    setScreenNavigationCommands({ triggerAnimatedPop: animateThenPop });
    return () => {
      setScreenNavigationCommands({ triggerAnimatedPop: null });
    };
  }, [animateThenPop, setScreenNavigationCommands]);

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
    navigationCanGoBack,
    usesTabletLayout,
    settingsAllowsDrawerGesture,
    drawerVisible,
    drawerWidth,
    screenWidth,
    drawerOffset,
    drawerDragStartOffset,
    drawerGestureDidSettle,
    backSwipeOffset,
    backSwipeDragStartOffset,
    backSwipeGestureDidSettle,
    onDrawerSettled: handleDrawerSettled,
    onToggleTabletSidebar: toggleTabletSidebar,
    onBackSwipe,
  });

  const drawerCommands = useMemo(
    () => ({ closeDrawer, toggleNavigation: handleNavigationToggle }),
    [closeDrawer, handleNavigationToggle],
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
    backSwipeUnderlayAnimatedStyle,
    backSwipePushedScreenAnimatedStyle,
  };
}
