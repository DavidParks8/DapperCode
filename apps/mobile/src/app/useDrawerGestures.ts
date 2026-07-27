import { useCallback, useMemo } from 'react';
import { useStore } from 'jotai';
import { Keyboard } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  cancelAnimation,
  ReduceMotion,
  runOnJS,
  type SharedValue,
  withSpring,
} from 'react-native-reanimated';

import {
  BACK_SWIPE_DISTANCE,
  BACK_SWIPE_VELOCITY,
  EDGE_SWIPE_WIDTH,
  type Screen,
} from './appConstants';
import {
  applyDrawerRubberBand,
  buildDrawerSpringConfig,
  clampDrawerOffset,
  shouldSettleDrawerOpen,
} from './appDrawerUtils';
import { drawerCapturesTouchesAtom, drawerVisibleAtom } from '../state/drawer/atoms';

interface UseDrawerGesturesArgs {
  currentScreen: Screen;
  navigationCanGoBack: boolean;
  usesTabletLayout: boolean;
  settingsAllowsDrawerGesture: boolean;
  drawerVisible: boolean;
  drawerWidth: number;
  screenWidth: number;
  drawerOffset: SharedValue<number>;
  drawerDragStartOffset: SharedValue<number>;
  drawerGestureDidSettle: SharedValue<boolean>;
  backSwipeOffset: SharedValue<number>;
  backSwipeDragStartOffset: SharedValue<number>;
  backSwipeGestureDidSettle: SharedValue<boolean>;
  onDrawerSettled: (isOpen: boolean) => void;
  onToggleTabletSidebar: () => void;
  onBackSwipe: () => void;
}

export function useDrawerGestures({
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
  onDrawerSettled,
  onToggleTabletSidebar,
  onBackSwipe,
}: UseDrawerGesturesArgs) {
  const store = useStore();

  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const ensureDrawerVisible = useCallback(() => {
    if (!store.get(drawerVisibleAtom)) {
      store.set(drawerVisibleAtom, true);
    }
  }, [store]);

  const ensureDrawerCapturesTouches = useCallback(() => {
    if (!store.get(drawerCapturesTouchesAtom)) {
      store.set(drawerCapturesTouchesAtom, true);
    }
  }, [store]);

  const beginDrawerInteraction = useCallback(() => {
    ensureDrawerVisible();
    ensureDrawerCapturesTouches();
  }, [ensureDrawerCapturesTouches, ensureDrawerVisible]);

  const handleDrawerSettled = onDrawerSettled;

  const settleBackSwipe = useCallback(
    (shouldNavigateBack: boolean, velocityX: number) => {
      'worklet';
      backSwipeOffset.value = withSpring(
        shouldNavigateBack ? screenWidth : 0,
        {
          ...buildDrawerSpringConfig(velocityX),
          overshootClamping: true,
          reduceMotion: ReduceMotion.System,
        },
        (finished) => {
          if (finished && shouldNavigateBack) {
            runOnJS(onBackSwipe)();
          }
        },
      );
    },
    [backSwipeOffset, onBackSwipe, screenWidth],
  );

  const animateDrawerTo = useCallback(
    (shouldOpen: boolean, velocityX = 0) => {
      if (usesTabletLayout) {
        handleDrawerSettled(false);
        drawerOffset.value = -drawerWidth;
        drawerDragStartOffset.value = -drawerWidth;
        return;
      }

      if (!shouldOpen && !store.get(drawerVisibleAtom)) {
        return;
      }

      if (shouldOpen) {
        dismissKeyboard();
        ensureDrawerCapturesTouches();
      }

      ensureDrawerVisible();
      drawerOffset.value = withSpring(
        shouldOpen ? 0 : -drawerWidth,
        buildDrawerSpringConfig(velocityX),
        (finished) => {
          if (finished) {
            runOnJS(handleDrawerSettled)(shouldOpen);
          }
        },
      );
    },
    [
      dismissKeyboard,
      drawerDragStartOffset,
      drawerOffset,
      drawerWidth,
      ensureDrawerCapturesTouches,
      ensureDrawerVisible,
      handleDrawerSettled,
      store,
      usesTabletLayout,
    ],
  );

  const openDrawer = useCallback(() => {
    animateDrawerTo(true);
  }, [animateDrawerTo]);

  const closeDrawer = useCallback(() => {
    animateDrawerTo(false);
  }, [animateDrawerTo]);

  const handleNavigationToggle = useCallback(() => {
    if (usesTabletLayout) {
      onToggleTabletSidebar();
      return;
    }

    openDrawer();
  }, [onToggleTabletSidebar, openDrawer, usesTabletLayout]);

  const backSwipeGesture = useMemo(() => {
    const animatesCurrentScreen = currentScreen === 'ChatGit';
    const canNavigateBack =
      navigationCanGoBack && (currentScreen !== 'Settings' || settingsAllowsDrawerGesture);
    return Gesture.Pan()
      .withTestId('app-back-swipe')
      .enabled(canNavigateBack)
      .hitSlop({ left: 0, width: EDGE_SWIPE_WIDTH })
      .activeOffsetX(12)
      .failOffsetY([-18, 18])
      .onStart((event) => {
        if (!animatesCurrentScreen) {
          return;
        }
        backSwipeGestureDidSettle.value = false;
        cancelAnimation(backSwipeOffset);
        backSwipeDragStartOffset.value = backSwipeOffset.value;
        backSwipeOffset.value = Math.max(
          0,
          Math.min(screenWidth, backSwipeDragStartOffset.value + event.translationX),
        );
      })
      .onUpdate((event) => {
        if (animatesCurrentScreen) {
          backSwipeOffset.value = Math.max(
            0,
            Math.min(screenWidth, backSwipeDragStartOffset.value + event.translationX),
          );
        }
      })
      .onEnd((event) => {
        const dragDistance = animatesCurrentScreen
          ? backSwipeDragStartOffset.value + event.translationX
          : event.translationX;
        const shouldNavigateBack =
          dragDistance > BACK_SWIPE_DISTANCE || event.velocityX > BACK_SWIPE_VELOCITY;
        if (!animatesCurrentScreen) {
          if (shouldNavigateBack) {
            runOnJS(onBackSwipe)();
          }
          return;
        }
        backSwipeGestureDidSettle.value = true;
        settleBackSwipe(shouldNavigateBack, event.velocityX);
      })
      .onFinalize((event) => {
        if (!animatesCurrentScreen || backSwipeGestureDidSettle.value) {
          return;
        }
        backSwipeGestureDidSettle.value = true;
        settleBackSwipe(false, event.velocityX);
      });
  }, [
    backSwipeGestureDidSettle,
    backSwipeDragStartOffset,
    backSwipeOffset,
    currentScreen,
    navigationCanGoBack,
    onBackSwipe,
    screenWidth,
    settingsAllowsDrawerGesture,
    settleBackSwipe,
  ]);

  const settleDrawerFromGesture = useCallback(
    (translationX: number, velocityX: number) => {
      'worklet';
      const nextOffset = clampDrawerOffset(drawerDragStartOffset.value + translationX, drawerWidth);
      const shouldOpen = shouldSettleDrawerOpen(
        nextOffset,
        velocityX,
        drawerWidth,
        drawerDragStartOffset.value,
      );
      drawerOffset.value = withSpring(
        shouldOpen ? 0 : -drawerWidth,
        buildDrawerSpringConfig(velocityX),
        (finished) => {
          if (finished) {
            runOnJS(handleDrawerSettled)(shouldOpen);
          }
        },
      );
    },
    [drawerDragStartOffset, drawerOffset, drawerWidth, handleDrawerSettled],
  );

  const openDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .withTestId('app-open-drawer')
        .enabled(!usesTabletLayout && currentScreen === 'Main' && !navigationCanGoBack)
        .activeOffsetX(12)
        .failOffsetY([-18, 18])
        .onStart(() => {
          drawerGestureDidSettle.value = false;
          cancelAnimation(drawerOffset);
          drawerDragStartOffset.value = drawerOffset.value;
          runOnJS(dismissKeyboard)();
          runOnJS(beginDrawerInteraction)();
        })
        .onUpdate((event) => {
          drawerOffset.value = applyDrawerRubberBand(
            drawerDragStartOffset.value + event.translationX,
            drawerWidth,
          );
        })
        .onEnd((event) => {
          drawerGestureDidSettle.value = true;
          settleDrawerFromGesture(event.translationX, event.velocityX);
        })
        .onFinalize((event) => {
          if (drawerGestureDidSettle.value) {
            return;
          }
          drawerGestureDidSettle.value = true;
          settleDrawerFromGesture(event.translationX, event.velocityX);
        }),
    [
      beginDrawerInteraction,
      currentScreen,
      dismissKeyboard,
      drawerDragStartOffset,
      drawerGestureDidSettle,
      drawerOffset,
      drawerWidth,
      navigationCanGoBack,
      settleDrawerFromGesture,
      usesTabletLayout,
    ],
  );

  const visibleDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(drawerVisible)
        .activeOffsetX([-8, 8])
        .failOffsetY([-18, 18])
        .onStart(() => {
          drawerGestureDidSettle.value = false;
          cancelAnimation(drawerOffset);
          drawerDragStartOffset.value = drawerOffset.value;
          runOnJS(ensureDrawerCapturesTouches)();
        })
        .onUpdate((event) => {
          drawerOffset.value = applyDrawerRubberBand(
            drawerDragStartOffset.value + event.translationX,
            drawerWidth,
          );
        })
        .onEnd((event) => {
          drawerGestureDidSettle.value = true;
          settleDrawerFromGesture(event.translationX, event.velocityX);
        })
        .onFinalize((event) => {
          if (drawerGestureDidSettle.value) {
            return;
          }
          drawerGestureDidSettle.value = true;
          settleDrawerFromGesture(event.translationX, event.velocityX);
        }),
    [
      drawerDragStartOffset,
      drawerGestureDidSettle,
      drawerOffset,
      drawerVisible,
      drawerWidth,
      ensureDrawerCapturesTouches,
      settleDrawerFromGesture,
    ],
  );

  const visibleDrawerTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .enabled(drawerVisible)
        .maxDistance(8)
        .onEnd((_event, success) => {
          if (success) {
            runOnJS(closeDrawer)();
          }
        }),
    [closeDrawer, drawerVisible],
  );

  return {
    closeDrawer,
    handleNavigationToggle,
    openDrawerGesture,
    visibleDrawerGesture,
    visibleDrawerTapGesture,
    backSwipeGesture,
  };
}
