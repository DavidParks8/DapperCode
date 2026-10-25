import { LinearGradient } from 'expo-linear-gradient';
import type { StyleProp, ViewStyle } from 'react-native';

import { useAppTheme } from '@shared/theme';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';

/**
 * Fades transcript content into the bottom of the screen.
 *
 * There is deliberately no matching scrim at the top: the chrome there is a glass plane, and a
 * gradient behind it only muddied the material while making the oldest message look clipped.
 */
export function TranscriptEdgeScrim({
  bottomInset,
  edgeStyle,
}: {
  bottomInset: number;
  edgeStyle: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  const sceneInsets = useSceneHorizontalInsets();
  if (bottomInset <= 0) {
    return null;
  }
  const bottomHeight = bottomInset + theme.spacing.xxl;

  return (
    // The composer is a glass plane sitting inside this band. A stop that reaches full opacity
    // before the composer would park that glass on flat black, leaving it nothing to refract, so
    // this ramps continuously across the whole band and only goes solid at the screen edge.
    <LinearGradient
      pointerEvents="none"
      colors={[theme.colors.transparent, theme.colors.bgMain]}
      // The transcript sits inside the scene's side safe-area padding, but a scrim is background:
      // it bleeds under that inset to the window edge instead of stopping beside the status bar.
      style={[
        edgeStyle,
        {
          bottom: 0,
          height: bottomHeight,
          left: -sceneInsets.paddingLeft,
          right: -sceneInsets.paddingRight,
        },
      ]}
      testID="transcript-bottom-scrim"
    />
  );
}
