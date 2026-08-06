import { memo, type ReactNode, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

import { useAppTheme, type AppTheme } from '@shared/theme';
import { formatMessageTimestamp } from './messageTimestamp';
import { MESSAGE_TIMESTAMP_REVEAL_DISTANCE } from './useMessageTimestampReveal';

interface MessageTimestampRevealProps {
  children: ReactNode;
  messageId: string;
  timestamp: string;
  translationX: SharedValue<number>;
}

export const MessageTimestampReveal = memo(function MessageTimestampReveal({
  children,
  messageId,
  timestamp,
  translationX,
}: MessageTimestampRevealProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const movingStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translationX.value }],
  }));
  const timestampStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, -translationX.value / 28)),
  }));

  return (
    <View style={styles.container} testID={`message-timestamp-reveal-${messageId}`}>
      <Animated.View
        pointerEvents="none"
        style={[styles.timestampContainer, timestampStyle]}
        testID={`message-timestamp-${messageId}`}
      >
        <Text style={styles.timestampText}>{formatMessageTimestamp(timestamp)}</Text>
      </Animated.View>
      <Animated.View style={movingStyle}>{children}</Animated.View>
    </View>
  );
});

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      overflow: 'hidden',
      position: 'relative',
    },
    timestampContainer: {
      alignItems: 'flex-end',
      bottom: 0,
      justifyContent: 'center',
      position: 'absolute',
      right: 0,
      top: 0,
      width: MESSAGE_TIMESTAMP_REVEAL_DISTANCE,
    },
    timestampText: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontVariant: ['tabular-nums'],
      textAlign: 'right',
    },
  });
}
