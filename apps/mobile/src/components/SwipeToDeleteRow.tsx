import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { decorativeAccessibilityProps } from '../accessibility';
import { useAppTheme, type AppTheme } from '../theme';

/** Width of the revealed action, matching the iOS Mail action column. */
export const SWIPE_ACTION_WIDTH = 92;
/**
 * The drawer swipe closes at 8px of horizontal travel, so the row has to claim the gesture before
 * that or the drawer would swallow every swipe.
 */
const SWIPE_ACTIVATION_OFFSET = 6;
const SWIPE_FAIL_OFFSET_Y = 12;
const SWIPE_OPEN_VELOCITY = -600;
/** Fraction of the row that has to be dragged before the swipe deletes without a second tap. */
const FULL_SWIPE_RATIO = 0.55;
const SWIPE_ANIMATION_MS = 180;

export interface SwipeToDeleteRowProps {
  children: React.ReactNode;
  /**
   * Resolving to `false` (or rejecting) springs the row back, which is what happens when the
   * confirmation is dismissed or the bridge rejects the delete.
   */
  onDelete: () => void | Promise<boolean | void>;
  deleteAccessibilityLabel: string;
  deleteLabel?: string;
  /** Painted behind the sliding content so the destructive layer stays hidden while at rest. */
  contentBackgroundColor?: string;
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * iOS Mail style row: dragging left reveals a destructive action, and dragging most of the way
 * across commits the delete without a second tap.
 */
export function SwipeToDeleteRow({
  children,
  onDelete,
  deleteAccessibilityLabel,
  deleteLabel = 'Delete',
  contentBackgroundColor,
  enabled = true,
  style,
}: SwipeToDeleteRowProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSwipeToDeleteRowStyles(theme), [theme]);
  const translateX = useSharedValue(0);
  const dragStartX = useSharedValue(0);
  const rowWidth = useSharedValue(0);
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    translateX.value = withTiming(0, { duration: SWIPE_ANIMATION_MS });
    setOpen(false);
  }, [translateX]);

  const commitDelete = useCallback(() => {
    setOpen(false);
    let result: void | Promise<boolean | void>;
    try {
      result = onDelete();
    } catch {
      close();
      return;
    }
    if (!result || typeof result.then !== 'function') {
      return;
    }
    void result.then(
      (deleted) => {
        if (deleted === false) {
          close();
        }
      },
      () => {
        close();
      },
    );
  }, [close, onDelete]);

  const settle = useCallback(
    (shouldOpen: boolean) => {
      setOpen(shouldOpen);
      translateX.value = withTiming(shouldOpen ? -SWIPE_ACTION_WIDTH : 0, {
        duration: SWIPE_ANIMATION_MS,
      });
    },
    [translateX],
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX(
          open ? [-SWIPE_ACTIVATION_OFFSET, SWIPE_ACTIVATION_OFFSET] : -SWIPE_ACTIVATION_OFFSET,
        )
        .failOffsetY([-SWIPE_FAIL_OFFSET_Y, SWIPE_FAIL_OFFSET_Y])
        .onStart(() => {
          dragStartX.value = translateX.value;
        })
        .onUpdate((event) => {
          const maxTranslate = rowWidth.value > 0 ? rowWidth.value : SWIPE_ACTION_WIDTH;
          const next = dragStartX.value + event.translationX;
          translateX.value = Math.min(0, Math.max(next, -maxTranslate));
        })
        .onEnd((event) => {
          const distance = -translateX.value;
          const width = rowWidth.value > 0 ? rowWidth.value : SWIPE_ACTION_WIDTH;
          if (distance >= width * FULL_SWIPE_RATIO) {
            translateX.value = withTiming(-width, { duration: SWIPE_ANIMATION_MS });
            runOnJS(commitDelete)();
            return;
          }
          const shouldOpen =
            distance > SWIPE_ACTION_WIDTH / 2 || event.velocityX < SWIPE_OPEN_VELOCITY;
          runOnJS(settle)(shouldOpen);
        }),
    [commitDelete, dragStartX, enabled, open, rowWidth, settle, translateX],
  );

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={style}>
      <View
        collapsable={false}
        onLayout={(event) => {
          rowWidth.value = event.nativeEvent.layout.width;
        }}
        style={[styles.clip, { backgroundColor: contentBackgroundColor ?? theme.colors.bgMain }]}
        testID="swipe-delete-clip"
      >
        <View
          style={styles.actionLayer}
          pointerEvents="box-none"
          testID="swipe-delete-action-layer"
        >
          <Pressable
            accessibilityHint="Deletes this session."
            accessibilityLabel={deleteAccessibilityLabel}
            accessibilityRole="button"
            onPress={commitDelete}
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="trash-outline"
              size={18}
              color={theme.colors.white}
            />
            <Text style={styles.actionLabel}>{deleteLabel}</Text>
          </Pressable>
        </View>
        <GestureDetector gesture={panGesture}>
          <Animated.View
            style={[
              styles.content,
              { backgroundColor: contentBackgroundColor ?? theme.colors.bgMain },
              contentStyle,
            ]}
            testID="swipe-delete-content"
          >
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

function createSwipeToDeleteRowStyles(theme: AppTheme) {
  return StyleSheet.create({
    clip: {
      position: 'relative',
      overflow: 'hidden',
    },
    actionLayer: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 0,
      flexDirection: 'row',
      alignItems: 'stretch',
      justifyContent: 'flex-end',
      backgroundColor: theme.colors.error,
    },
    action: {
      width: SWIPE_ACTION_WIDTH,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      backgroundColor: theme.colors.error,
    },
    content: {
      zIndex: 1,
    },
    actionPressed: {
      opacity: 0.82,
    },
    actionLabel: {
      ...theme.typography.caption,
      color: theme.colors.white,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '600',
    },
  });
}
