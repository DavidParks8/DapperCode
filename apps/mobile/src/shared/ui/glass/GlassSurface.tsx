import { forwardRef, type PropsWithChildren } from 'react';
import { GlassView, type GlassViewProps } from 'expo-glass-effect';
import { StyleSheet, type StyleProp, type View, type ViewStyle } from 'react-native';

import { useAppTheme, type GlassSurfaceRole } from '@shared/theme';
import { isGlassAvailable } from '@shared/ui/glass/capability';

export interface GlassSurfaceProps extends PropsWithChildren<
  Omit<
    GlassViewProps,
    'colorScheme' | 'glassEffectStyle' | 'isInteractive' | 'ref' | 'role' | 'style' | 'tintColor'
  >
> {
  role: GlassSurfaceRole;
  style?: StyleProp<ViewStyle>;
  isInteractive?: boolean;
}

/**
 * A native Liquid Glass surface on supported iOS devices and a themed solid surface everywhere
 * else. Glass views must not be faded with opacity: UIKit stops rendering the material when this
 * view or one of its ancestors reaches zero opacity.
 */
export const GlassSurface = forwardRef<View, GlassSurfaceProps>(function GlassSurface(
  { role, style, isInteractive = false, ...viewProps },
  ref,
) {
  const theme = useAppTheme();
  const surface = theme.glass[role];
  const glassAvailable = isGlassAvailable();
  const flattenedStyle = StyleSheet.flatten(style) ?? {};
  const {
    backgroundColor: requestedBackgroundColor,
    borderColor: requestedBorderColor,
    borderWidth: requestedBorderWidth,
    ...layoutStyle
  } = flattenedStyle;

  if (__DEV__ && (requestedBackgroundColor !== undefined || requestedBorderColor !== undefined)) {
    console.warn(
      'GlassSurface owns backgroundColor and borderColor. Remove those properties from the calling style instead.',
    );
  }

  const fallbackStyle = glassAvailable
    ? undefined
    : {
        backgroundColor: surface.fallbackBackgroundColor,
        ...(requestedBorderWidth === undefined
          ? {}
          : {
              borderColor: surface.fallbackBorderColor,
              borderWidth: requestedBorderWidth,
            }),
      };

  return (
    <GlassView
      ref={ref}
      {...viewProps}
      colorScheme={theme.mode}
      glassEffectStyle={glassAvailable ? surface.glassEffectStyle : 'none'}
      isInteractive={isInteractive}
      tintColor={glassAvailable ? surface.tintColor : undefined}
      style={[layoutStyle, fallbackStyle]}
    />
  );
});
