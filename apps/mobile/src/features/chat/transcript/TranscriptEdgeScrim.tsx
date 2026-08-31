import { LinearGradient } from 'expo-linear-gradient';
import type { StyleProp, ViewStyle } from 'react-native';

import { useAppTheme } from '@shared/theme';

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
      style={[edgeStyle, { bottom: 0, height: bottomHeight }]}
      testID="transcript-bottom-scrim"
    />
  );
}
