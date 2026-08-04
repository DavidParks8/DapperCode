import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { type AppTheme, useAppTheme } from '@shared/theme';
import { highlightCode, renderSyntaxTokens, resolveSyntaxLanguage } from './syntaxHighlight';

const COPY_STATUS_RESET_MS = 1600;

type CopyStatus = 'idle' | 'copied' | 'error';

export function ChatCodeBlock({
  code,
  language,
  selectable = true,
}: {
  code: string;
  language?: string | null;
  selectable?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syntax = useMemo(() => resolveSyntaxLanguage(language), [language]);
  const highlightedCode = useMemo(
    () => highlightCode(code, syntax.grammar),
    [code, syntax.grammar],
  );

  useEffect(
    () => () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void Clipboard.setStringAsync(code)
      .then(() => {
        void feedback.success();
        setCopyStatus('copied');
        if (resetTimerRef.current) {
          clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = setTimeout(() => setCopyStatus('idle'), COPY_STATUS_RESET_MS);
      })
      .catch(() => {
        setCopyStatus('error');
      });
  }, [code]);

  const copyLabel = copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Retry' : 'Copy';
  const copyColor = copyStatus === 'error' ? theme.colors.error : theme.colors.textSecondary;

  return (
    <View style={styles.surface} testID="chat-code-block">
      <View style={styles.header}>
        <Text style={styles.languageLabel} numberOfLines={1}>
          {syntax.label}
        </Text>
        <Pressable
          testID="chat-code-block-copy"
          onPress={handleCopy}
          style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel={
            copyStatus === 'copied'
              ? 'Code copied'
              : copyStatus === 'error'
                ? 'Copy failed. Try again'
                : 'Copy code'
          }
          accessibilityHint="Copies this code block to the clipboard"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name={
              copyStatus === 'copied'
                ? 'checkmark-outline'
                : copyStatus === 'error'
                  ? 'alert-circle-outline'
                  : 'copy-outline'
            }
            size={15}
            color={copyColor}
          />
          <Text style={[styles.copyLabel, copyStatus === 'error' && styles.copyLabelError]}>
            {copyLabel}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        testID="chat-code-block-scroll"
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        <Text selectable={selectable} style={styles.code}>
          {renderSyntaxTokens(highlightedCode, styles)}
        </Text>
      </ScrollView>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    surface: {
      width: '100%',
      maxWidth: '100%',
      marginVertical: theme.spacing.sm,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.bgElevated,
    },
    header: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
    },
    languageLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.35,
      flexShrink: 1,
    },
    copyButton: {
      minWidth: theme.touchTarget.minimum,
      minHeight: theme.touchTarget.minimum,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    copyButtonPressed: { backgroundColor: theme.colors.bgCanvasAccent },
    copyLabel: {
      ...theme.typography.label,
      color: theme.colors.textSecondary,
    },
    copyLabelError: { color: theme.colors.error },
    scroll: { width: '100%', maxWidth: '100%' },
    scrollContent: {
      minWidth: '100%',
      alignItems: 'flex-start',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    code: {
      ...theme.typography.mono,
      color: theme.colors.inlineCodeText,
      alignSelf: 'flex-start',
      flexShrink: 0,
    },
    syntaxComment: { color: theme.colors.codeSyntaxComment },
    syntaxKeyword: { color: theme.colors.codeSyntaxKeyword },
    syntaxString: { color: theme.colors.codeSyntaxString },
    syntaxNumber: { color: theme.colors.codeSyntaxNumber },
    syntaxFunction: { color: theme.colors.codeSyntaxFunction },
    syntaxProperty: { color: theme.colors.codeSyntaxProperty },
    syntaxOperator: { color: theme.colors.codeSyntaxOperator },
  });
