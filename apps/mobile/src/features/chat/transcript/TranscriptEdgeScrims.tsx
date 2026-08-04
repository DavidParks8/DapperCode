import { LinearGradient } from 'expo-linear-gradient';
import type { StyleProp, ViewStyle } from 'react-native';

import { useAppTheme } from '@shared/theme';

export function TranscriptEdgeScrims({
  topInset,
  bottomInset,
  edgeStyle,
}: {
  topInset: number;
  bottomInset: number;
  edgeStyle: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  const fadeHeight = theme.spacing.xxl;
  const bottomHeight = bottomInset + fadeHeight;

  return (
    <>
      <LinearGradient
        pointerEvents="none"
        colors={[theme.colors.bgMain, theme.colors.transparent]}
        style={[edgeStyle, { top: topInset, height: fadeHeight }]}
        testID="transcript-top-scrim"
      />
      <LinearGradient
        pointerEvents="none"
        colors={[theme.colors.transparent, theme.colors.bgMain, theme.colors.bgMain]}
        locations={[0, fadeHeight / bottomHeight, 1]}
        style={[edgeStyle, { bottom: 0, height: bottomHeight }]}
        testID="transcript-bottom-scrim"
      />
    </>
  );
}
