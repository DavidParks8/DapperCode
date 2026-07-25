import { useCallback, useMemo } from 'react';
import { Keyboard } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  cancelAnimation,
  runOnJS,
  type SharedValue,
  withSpring,
} from 'react-native-reanimated';

import {
  CHAT_GIT_BACK_DISTANCE,
  CHAT_GIT_BACK_VELOCITY,
  type Screen,
} from './appConstants';
import {
  applyDrawerRubberBand,
  buildDrawerSpringConfig,
  clampDrawerOffset,
  shouldSettleDrawerOpen,
} from './appDrawerUtils';

interface UseDrawerGesturesArgs {
  currentScreen: Screen;
  usesTabletLayout: boolean;
  settingsAllowsDrawerGesture: boolean;
  drawerVisible: boolean;
  drawerWidth: number;
  drawerOffset: SharedValue<number>;
  drawerDragStartOffset: SharedValue<number>;
  drawerGestureDidSettle: SharedValue<boolean>;
  drawerVisibleRef: React.MutableRefObject<boolean>;
  drawerCapturesTouchesRef: React.MutableRefObject<boolean>;
  setDrawerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setDrawerCapturesTouches: React.Dispatch<React.SetStateAction<boolean>>;
  onDrawerSettled: (isOpen: boolean) => void;
  onToggleTabletSidebar: () => void;
  onChatGitBack: () => void;
}

export function useDrawerGestures({
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
  onDrawerSettled,
  onToggleTabletSidebar,
  onChatGitBack,
}: UseDrawerGesturesArgs) {
  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const ensureDrawerVisible = useCallback(() => {
    if (drawerVisibleRef.current) {
      return;
    }

    drawerVisibleRef.current = true;
    setDrawerVisible(true);
  }, [drawerVisibleRef, setDrawerVisible]);

  const ensureDrawerCapturesTouches = useCallback(() => {
    if (drawerCapturesTouchesRef.current) {
      return;
    }

    drawerCapturesTouchesRef.current = true;
    setDrawerCapturesTouches(true);
  }, [drawerCapturesTouchesRef, setDrawerCapturesTouches]);

  const beginDrawerInteraction = useCallback(() => {
    ensureDrawerVisible();
    ensureDrawerCapturesTouches();
  }, [ensureDrawerCapturesTouches, ensureDrawerVisible]);

  const handleDrawerSettled = onDrawerSettled;

  const animateDrawerTo = useCallback(
    (shouldOpen: boolean, velocityX = 0) => {
      if (usesTabletLayout) {
        handleDrawerSettled(false);
        drawerOffset.value = -drawerWidth;
        drawerDragStartOffset.value = -drawerWidth;
        return;
      }

      if (!shouldOpen && !drawerVisibleRef.current) {
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
        }
      );
    },
    [
      dismissKeyboard,
      drawerDragStartOffset,
      drawerOffset,
      drawerVisibleRef,
      drawerWidth,
      ensureDrawerCapturesTouches,
      ensureDrawerVisible,
      handleDrawerSettled,
      usesTabletLayout,
    ]
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

  const chatGitBackGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ right: 12 })
        .activeOffsetX(12)
        .failOffsetY([-18, 18])
        .onEnd((event) => {
          if (
            event.translationX > CHAT_GIT_BACK_DISTANCE ||
            event.velocityX > CHAT_GIT_BACK_VELOCITY
          ) {
            runOnJS(onChatGitBack)();
          }
        }),
    [onChatGitBack]
  );

  const settleDrawerFromGesture = useCallback(
    (translationX: number, velocityX: number) => {
      'worklet';
      const nextOffset = clampDrawerOffset(
        drawerDragStartOffset.value + translationX,
        drawerWidth
      );
      const shouldOpen = shouldSettleDrawerOpen(
        nextOffset,
        velocityX,
        drawerWidth,
        drawerDragStartOffset.value
      );
      drawerOffset.value = withSpring(
        shouldOpen ? 0 : -drawerWidth,
        buildDrawerSpringConfig(velocityX),
        (finished) => {
          if (finished) {
            runOnJS(handleDrawerSettled)(shouldOpen);
          }
        }
      );
    },
    [drawerDragStartOffset, drawerOffset, drawerWidth, handleDrawerSettled]
  );

  const openDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(
          !usesTabletLayout &&
            currentScreen !== 'ChatGit' &&
            currentScreen !== 'Browser' &&
            (currentScreen !== 'Settings' || settingsAllowsDrawerGesture)
        )
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
            drawerWidth
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
      settingsAllowsDrawerGesture,
      settleDrawerFromGesture,
      usesTabletLayout,
    ]
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
            drawerWidth
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
    ]
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
    [closeDrawer, drawerVisible]
  );

  return {
    closeDrawer,
    handleNavigationToggle,
    openDrawerGesture,
    visibleDrawerGesture,
    visibleDrawerTapGesture,
    chatGitBackGesture,
  };
}
