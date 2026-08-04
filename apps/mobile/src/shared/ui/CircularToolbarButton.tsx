import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useAppTheme, type AppTheme } from '@shared/theme';

export const CIRCULAR_TOOLBAR_BUTTON_SIZE = 48;

export interface CircularToolbarButtonProps extends Omit<
  PressableProps,
  'accessibilityLabel' | 'accessibilityRole' | 'children' | 'style'
> {
  accessibilityLabel: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function resolveCircularToolbarButtonStyle(
  theme: AppTheme,
  state: { pressed: boolean; disabled: boolean },
  style?: StyleProp<ViewStyle>,
): StyleProp<ViewStyle> {
  return [
    styles.button,
    {
      borderRadius: theme.radius.full,
      width: CIRCULAR_TOOLBAR_BUTTON_SIZE,
      height: CIRCULAR_TOOLBAR_BUTTON_SIZE,
    },
    state.pressed && !state.disabled && { backgroundColor: theme.colors.bgCanvasAccent },
    state.disabled && styles.disabled,
    style,
  ];
}

export function CircularToolbarButton({
  children,
  disabled,
  style,
  ...pressableProps
}: CircularToolbarButtonProps) {
  const theme = useAppTheme();

  return (
    <Pressable
      {...pressableProps}
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) =>
        resolveCircularToolbarButtonStyle(theme, { pressed, disabled: Boolean(disabled) }, style)
      }
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  disabled: {
    opacity: 0.5,
  },
});
