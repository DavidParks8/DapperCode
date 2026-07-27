import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { decorativeAccessibilityProps } from '../accessibility';
import { useAppTheme } from '../theme';
import { createStyles } from './chatMessageStyles';

const COPIED_RESET_MS = 1600;

export function MessageCopyButton({ text, testID }: { text: string; testID?: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void Clipboard.setStringAsync(text).catch(() => {});
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, COPIED_RESET_MS);
  }, [text]);

  if (!text.trim()) return null;

  return (
    <View style={styles.messageActionRow}>
      <Pressable
        testID={testID}
        onPress={handleCopy}
        hitSlop={8}
        style={({ pressed }) => [
          styles.messageActionButton,
          pressed && styles.messageActionButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Copied message' : 'Copy message'}
        accessibilityHint="Copies this response to the clipboard"
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={copied ? 'checkmark-outline' : 'copy-outline'}
          size={16}
          color={copied ? theme.colors.success : theme.colors.textMuted}
        />
      </Pressable>
    </View>
  );
}
