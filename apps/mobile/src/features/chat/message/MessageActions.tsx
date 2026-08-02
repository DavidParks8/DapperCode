import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { feedback } from '@shared/feedback';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { createStyles } from './styles';

const COPIED_RESET_MS = 1600;
const ACTION_BUTTON_VISIBLE_SIZE = { width: 30, height: 30 };

/**
 * The action row under a response: copy the whole thing, or open it for real text selection.
 *
 * Selection needs its own affordance because React Native's `<Text selectable>` cannot select a
 * range - see `SelectableTextSheet`.
 */
export function MessageActions({
  text,
  onSelectText,
  testID,
}: {
  text: string;
  onSelectText?: () => void;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionHitSlop = useMemo(() => computeHitSlop(ACTION_BUTTON_VISIBLE_SIZE), []);

  useEffect(
    () => () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void Clipboard.setStringAsync(text).catch(() => {});
    void feedback.success();
    setCopied(true);
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, COPIED_RESET_MS);
  }, [text]);

  if (!text.trim()) {
    return null;
  }

  return (
    <View style={styles.messageActionRow}>
      <Pressable
        testID={testID}
        onPress={handleCopy}
        hitSlop={actionHitSlop}
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
      {onSelectText ? (
        <Pressable
          testID={testID ? `${testID}-select` : undefined}
          onPress={onSelectText}
          hitSlop={actionHitSlop}
          style={({ pressed }) => [
            styles.messageActionButton,
            pressed && styles.messageActionButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Select message text"
          accessibilityHint="Opens this response so you can select part of it"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="text-outline"
            size={16}
            color={theme.colors.textMuted}
          />
        </Pressable>
      ) : null}
    </View>
  );
}
