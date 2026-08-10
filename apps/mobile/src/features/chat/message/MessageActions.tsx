import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useAtom } from 'jotai';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Pressable, View, type View as RNView } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import type { MessageTokenUsage } from '@bridge/types/types';
import { useAppTheme } from '@shared/theme';
import { feedback } from '@shared/feedback';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { responseUsageOverlayAtom } from '../state/modals';
import { measureAnchor } from './measureAnchor';
import { createStyles } from './styles';

const COPIED_RESET_MS = 1600;
const ACTION_BUTTON_VISIBLE_SIZE = { width: 30, height: 30 };

/** One icon-only control in the action row, sized and padded identically to its siblings. */
function ActionButton({
  accessibilityHint,
  accessibilityLabel,
  active = false,
  anchorRef,
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
  /** Set on controls whose position a floating surface has to be anchored to. */
  anchorRef?: RefObject<RNView | null>;
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
      ref={anchorRef}
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
  infoButtonRef,
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
  infoButtonRef: RefObject<RNView | null>;
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
          anchorRef={infoButtonRef}
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
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoButtonRef = useRef<RNView | null>(null);
  const [overlay, setOverlay] = useAtom(responseUsageOverlayAtom);
  const overlayId = useId();
  const usageVisible = overlay?.id === overlayId;

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
    if (usageVisible) {
      setOverlay(null);
      return;
    }
    if (!usage) {
      return;
    }
    // Opening cannot wait on measurement: the callback lands a frame later, and on some hosts
    // never at all, which would silently swallow the tap. The panel stays parked off screen until
    // its anchor arrives.
    setOverlay({ id: overlayId, anchor: null, usage });
    measureAnchor(infoButtonRef.current, (anchor) => {
      setOverlay((current) => (current?.id === overlayId ? { ...current, anchor } : current));
    });
  }, [overlayId, setOverlay, usage, usageVisible]);

  useEffect(
    () => () => {
      // An unmounting row cannot own a panel: the transcript virtualises rows out of existence.
      setOverlay((current) => (current?.id === overlayId ? null : current));
    },
    [overlayId, setOverlay],
  );

  const hasText = Boolean(text.trim());
  if (!hasText && !onForkConversation && !usage) {
    return null;
  }

  return (
    <MessageActionRow
      copied={copied}
      forkBusy={forkBusy}
      hasText={hasText}
      infoButtonRef={infoButtonRef}
      onCopy={handleCopy}
      onForkConversation={onForkConversation}
      onSelectText={onSelectText}
      onToggleUsage={toggleUsage}
      showUsageAction={Boolean(usage)}
      styles={styles}
      testID={testID}
      usageVisible={usageVisible}
    />
  );
}
