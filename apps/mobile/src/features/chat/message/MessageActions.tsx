import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import type { MessageTokenUsage } from '@bridge/types/types';
import { useAppTheme } from '@shared/theme';
import { feedback } from '@shared/feedback';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { buildResponseUsageStats, buildResponseUsageSummary } from './responseUsage';
import { createStyles } from './styles';

const COPIED_RESET_MS = 1600;
const ACTION_BUTTON_VISIBLE_SIZE = { width: 30, height: 30 };

/**
 * What a response cost, floated over the transcript from the info button rather than inserted
 * into it.
 *
 * Expanding in flow pushed every message below it down, so the response the reader was looking at
 * moved out from under their eyes. Anchoring the panel above the action row keeps that response
 * fixed, and because it overlays earlier siblings it needs no z-order juggling. The panel rides
 * the same capsule glass material as the rest of the chat chrome so it reads as floating rather
 * than as an opaque block pasted over the text.
 */
function ResponseUsageCard({
  onDismiss,
  usage,
  styles,
  testID,
}: {
  onDismiss: () => void;
  usage: MessageTokenUsage;
  styles: ReturnType<typeof createStyles>;
  testID?: string;
}) {
  const stats = useMemo(() => buildResponseUsageStats(usage), [usage]);
  return (
    <Pressable
      testID={testID ? `${testID}-panel` : undefined}
      onPress={onDismiss}
      style={styles.responseUsagePopover}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Response details. ${buildResponseUsageSummary(usage)}`}
      accessibilityHint="Hides these details"
    >
      <GlassSurface role="capsule" testID={testID} style={styles.responseUsageCard}>
        {stats.map((stat) => (
          <View key={stat.key} style={styles.responseUsageRow} accessibilityElementsHidden>
            <Text style={styles.responseUsageLabel}>{stat.label}</Text>
            <Text style={styles.responseUsageValue} numberOfLines={1}>
              {stat.value}
            </Text>
          </View>
        ))}
      </GlassSurface>
    </Pressable>
  );
}

/** One icon-only control in the action row, sized and padded identically to its siblings. */
function ActionButton({
  accessibilityHint,
  accessibilityLabel,
  active = false,
  busy = false,
  color,
  expanded,
  hitSlop,
  icon,
  onPress,
  styles,
  testID,
}: {
  accessibilityHint: string;
  accessibilityLabel: string;
  active?: boolean;
  busy?: boolean;
  color: string;
  expanded?: boolean;
  hitSlop: ReturnType<typeof computeHitSlop>;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={busy}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        styles.messageActionButton,
        (active || (pressed && !busy)) && styles.messageActionButtonPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={controlAccessibilityState({
        busy: busy ? true : undefined,
        disabled: busy,
        expanded,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Ionicons {...decorativeAccessibilityProps} name={icon} size={16} color={color} />
      )}
    </Pressable>
  );
}

/** The row of icon controls itself, kept apart so the disclosure state above stays readable. */
function MessageActionRow({
  copied,
  forkBusy,
  hasText,
  onCopy,
  onForkConversation,
  onSelectText,
  onToggleUsage,
  showUsageAction,
  styles,
  testID,
  usageVisible,
}: {
  copied: boolean;
  forkBusy: boolean;
  hasText: boolean;
  onCopy: () => void;
  onForkConversation?: () => void;
  onSelectText?: () => void;
  onToggleUsage: () => void;
  showUsageAction: boolean;
  styles: ReturnType<typeof createStyles>;
  testID?: string;
  usageVisible: boolean;
}) {
  const theme = useAppTheme();
  const hitSlop = useMemo(() => computeHitSlop(ACTION_BUTTON_VISIBLE_SIZE), []);
  const shared = { hitSlop, styles } as const;

  return (
    <View style={styles.messageActionRow}>
      {showUsageAction ? (
        <ActionButton
          {...shared}
          testID={testID ? `${testID}-info` : undefined}
          onPress={onToggleUsage}
          active={usageVisible}
          expanded={usageVisible}
          icon={usageVisible ? 'information-circle' : 'information-circle-outline'}
          color={usageVisible ? theme.colors.textPrimary : theme.colors.textMuted}
          accessibilityLabel="Response details"
          accessibilityHint="Shows the model and token usage for this response"
        />
      ) : null}
      {hasText ? (
        <ActionButton
          {...shared}
          testID={testID}
          onPress={onCopy}
          icon={copied ? 'checkmark-outline' : 'copy-outline'}
          color={copied ? theme.colors.success : theme.colors.textMuted}
          accessibilityLabel={copied ? 'Copied message' : 'Copy message'}
          accessibilityHint="Copies this response to the clipboard"
        />
      ) : null}
      {hasText && onSelectText ? (
        <ActionButton
          {...shared}
          testID={testID ? `${testID}-select` : undefined}
          onPress={onSelectText}
          icon="text-outline"
          color={theme.colors.textMuted}
          accessibilityLabel="Select message text"
          accessibilityHint="Opens this response so you can select part of it"
        />
      ) : null}
      {onForkConversation ? (
        <ActionButton
          {...shared}
          testID={testID ? `${testID}-fork` : undefined}
          onPress={onForkConversation}
          busy={forkBusy}
          icon="git-branch-outline"
          color={theme.colors.textMuted}
          accessibilityLabel="Fork conversation from here"
          accessibilityHint="Creates a new conversation containing the requests completed through this response"
        />
      ) : null}
    </View>
  );
}

/**
 * The actions under a response: copy the whole thing, open it for real text selection, fork from
 * it, or reveal what the turn cost.
 *
 * Selection needs its own affordance because React Native's `<Text selectable>` cannot select a
 * range - see `SelectableTextSheet`.
 */
export function MessageActions({
  text,
  usage = null,
  onSelectText,
  onForkConversation,
  forkBusy = false,
  testID,
}: {
  text: string;
  usage?: MessageTokenUsage | null;
  onSelectText?: () => void;
  onForkConversation?: () => void;
  forkBusy?: boolean;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [copied, setCopied] = useState(false);
  const [usageVisible, setUsageVisible] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const toggleUsage = useCallback(() => {
    void feedback.selection();
    setUsageVisible((previous) => !previous);
  }, []);

  const hasText = Boolean(text.trim());
  if (!hasText && !onForkConversation && !usage) {
    return null;
  }

  return (
    <View
      testID={testID ? `${testID}-actions` : undefined}
      style={usageVisible ? styles.messageActionsRootRaised : undefined}
    >
      <MessageActionRow
        copied={copied}
        forkBusy={forkBusy}
        hasText={hasText}
        onCopy={handleCopy}
        onForkConversation={onForkConversation}
        onSelectText={onSelectText}
        onToggleUsage={toggleUsage}
        showUsageAction={Boolean(usage)}
        styles={styles}
        testID={testID}
        usageVisible={usageVisible}
      />
      {usage && usageVisible ? (
        <ResponseUsageCard
          onDismiss={toggleUsage}
          usage={usage}
          styles={styles}
          testID={testID ? `${testID}-info-card` : undefined}
        />
      ) : null}
    </View>
  );
}
