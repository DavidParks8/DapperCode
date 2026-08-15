import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useAppTheme, type AppTheme } from '@shared/theme';

const MASK_VISIBLE = 'rgba(0, 0, 0, 1)';
const MASK_HIDDEN = 'rgba(0, 0, 0, 0)';
const HORIZONTAL_START = { x: 0, y: 0.5 };
const HORIZONTAL_END = { x: 1, y: 0.5 };

export function HorizontalFadeMask({
  active,
  fadeStart,
  fadeEnd,
  style,
  testID,
  children,
}: {
  active: boolean;
  fadeStart: boolean;
  fadeEnd: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  if (!active) {
    return (
      <View style={style} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <MaskedView
      style={style}
      testID={testID}
      maskElement={
        <View style={styles.mask}>
          {fadeStart ? (
            <LinearGradient
              colors={[MASK_HIDDEN, MASK_VISIBLE]}
              start={HORIZONTAL_START}
              end={HORIZONTAL_END}
              style={styles.maskEdge}
              testID={testID === undefined ? undefined : `${testID}-fade-start`}
            />
          ) : null}
          <View style={styles.maskCore} />
          {fadeEnd ? (
            <LinearGradient
              colors={[MASK_VISIBLE, MASK_HIDDEN]}
              start={HORIZONTAL_START}
              end={HORIZONTAL_END}
              style={styles.maskEdge}
              testID={testID === undefined ? undefined : `${testID}-fade-end`}
            />
          ) : null}
        </View>
      }
    >
      {children}
    </MaskedView>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    mask: { flex: 1, flexDirection: 'row' },
    maskEdge: { width: theme.spacing.xl },
    maskCore: { flex: 1, backgroundColor: MASK_VISIBLE },
  });
