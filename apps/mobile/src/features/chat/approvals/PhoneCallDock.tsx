import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Markdown from 'react-native-markdown-display';

import type { BridgeUiSurface } from '@bridge/types/types';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
} from '@shared/accessibility';
import { createWorkflowMarkdownStyles } from '../styles/styles';
import { getBridgeUiSurfaceReceivedAt } from '../helpers/bridgeUi';
import type { BridgeUiActionHandler } from './SurfaceRenderers';
import {
  formatCallElapsed,
  phoneCallModel,
  phoneCallStatusLine,
  type HangupState,
  type PhoneCallModel,
  type PhoneCallPhase,
} from './phoneCallModel';

interface PhoneCallDockProps {
  surface: BridgeUiSurface;
  /** Tallest the expanded details may grow without reaching the top chrome. */
  detailsMaxHeight: number;
  onAction: BridgeUiActionHandler;
  onDismiss: (surface: BridgeUiSurface) => void;
}

const FOLLOW_LATEST_SLOP = 24;
// The dock's header row, the gap below it, and a one-line composer stay on screen when expanded.
const EXPANDED_FIXED_CONTROLS_HEIGHT = 114;
const ADDITIONAL_DOCK_ROW_HEIGHT = 60;

/**
 * Expanded details share the reading space left between the top chrome, the fixed call and
 * composer controls, and the keyboard or safe area evenly with the chat transcript, so neither
 * shrinks to a sliver on a laptop-pose Duo's short upper display.
 */
export function phoneCallDetailsMaxHeight(options: {
  windowHeight: number;
  topChromeHeight: number;
  bottomInset: number;
  dockCount?: number;
}): number {
  const count = Math.max(1, options.dockCount ?? 1);
  const extraRows = (count - 1) * ADDITIONAL_DOCK_ROW_HEIGHT;
  const reading =
    options.windowHeight -
    options.topChromeHeight -
    options.bottomInset -
    EXPANDED_FIXED_CONTROLS_HEIGHT -
    extraRows;
  return Math.max(0, Math.min(Math.floor(reading / 2 / count), 300));
}

/**
 * A live call is ambient context while the user keeps chatting, so it rests as one glanceable row
 * above the composer — who, what state, how long, and Hang Up — and reveals the transcript only on
 * request.
 */
export function PhoneCallDock({
  surface,
  detailsMaxHeight,
  onAction,
  onDismiss,
}: PhoneCallDockProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const model = useMemo(() => phoneCallModel(surface), [surface]);
  const [expanded, setExpanded] = useState(false);
  const [hangup, setHangup] = useState<HangupState>('idle');
  const elapsed = useCallElapsedSeconds(model, getBridgeUiSurfaceReceivedAt(surface));
  const statusLine = phoneCallStatusLine(model, elapsed, hangup);
  const accent = phaseColor(theme, model.phase);
  const hangupAction = model.hangupAction;
  const settled = model.phase === 'ended' || model.phase === 'failed';

  // Announce state changes and the outcome, never each tick of the timer.
  useAccessibilityAnnouncement(
    `${model.callee}: ${settled || hangup !== 'idle' ? statusLine : model.status}`,
  );

  useEffect(() => {
    if (!hangupAction) {
      setHangup('idle');
    }
  }, [hangupAction]);

  useEffect(() => {
    if (settled) {
      setExpanded(false);
    }
  }, [settled]);

  return (
    <View style={styles.card} testID="phone-call-dock">
      <View style={styles.row}>
        <Pressable
          onPress={() => {
            void feedback.selection();
            setExpanded((value) => !value);
          }}
          style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Phone call with ${model.callee}, ${statusLine}`}
          accessibilityHint={
            expanded ? 'Hides the call details' : 'Shows the live transcript and call details'
          }
          accessibilityState={controlAccessibilityState({ expanded })}
          testID="phone-call-dock-toggle"
        >
          <View
            style={[styles.indicator, { backgroundColor: phaseBackground(theme, model.phase) }]}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name={model.phase === 'held' ? 'pause' : 'call'}
              size={15}
              color={accent}
            />
          </View>
          <View style={styles.copy}>
            <Text style={styles.callee} numberOfLines={1} ellipsizeMode="middle">
              {model.callee}
            </Text>
            <Text
              style={[styles.status, hangup === 'failed' && styles.statusError]}
              numberOfLines={1}
              testID="phone-call-dock-status"
            >
              {statusLine}
            </Text>
          </View>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={16}
            color={theme.colors.textMuted}
          />
        </Pressable>
        {hangupAction ? (
          <Pressable
            onPress={() => {
              void feedback.destructive();
              setHangup('pending');
              const outcome = onAction(surface, hangupAction);
              if (outcome instanceof Promise) {
                void outcome.then((ok) => {
                  if (!ok) {
                    setHangup('failed');
                  }
                });
              }
            }}
            disabled={hangup === 'pending'}
            hitSlop={computeHitSlop({ width: 40, height: 40 })}
            style={({ pressed }) => [
              styles.hangup,
              (pressed || hangup === 'pending') && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={hangupAction.label}
            accessibilityState={controlAccessibilityState({
              disabled: hangup === 'pending',
              busy: hangup === 'pending',
            })}
            testID="phone-call-dock-hangup"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="call"
              size={18}
              color={theme.colors.white}
              style={styles.hangupGlyph}
            />
          </Pressable>
        ) : surface.dismissible !== false ? (
          <Pressable
            onPress={() => onDismiss(surface)}
            hitSlop={computeHitSlop({ width: 28, height: 28 })}
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Dismiss call summary"
            testID="phone-call-dock-dismiss"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="close"
              size={16}
              color={theme.colors.textMuted}
            />
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <PhoneCallDetails
          model={model}
          maxHeight={detailsMaxHeight}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

function PhoneCallDetails({
  model,
  maxHeight,
  styles,
  theme,
}: {
  model: PhoneCallModel;
  maxHeight: number;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const markdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);
  const scrollRef = useRef<ScrollView>(null);
  const followingLatest = useRef(true);
  // Live calls read like a chat: keep the newest line in view unless the user scrolls back.
  const followLatest = model.hangupAction !== null;
  const settled = model.phase === 'ended' || model.phase === 'failed';

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    followingLatest.current =
      contentSize.height - contentOffset.y - layoutMeasurement.height < FOLLOW_LATEST_SLOP;
  };

  return (
    <ScrollView
      ref={scrollRef}
      nestedScrollEnabled
      bounces={false}
      style={{ maxHeight }}
      contentContainerStyle={styles.details}
      onScroll={handleScroll}
      scrollEventThrottle={64}
      onContentSizeChange={() => {
        if (followLatest && followingLatest.current) {
          scrollRef.current?.scrollToEnd({ animated: false });
        }
      }}
      testID="phone-call-dock-details"
    >
      {model.outcome ? (
        <DetailField label={model.outcome.label} value={model.outcome.value} styles={styles} />
      ) : null}
      {model.details ? (
        <DetailField label="Details" value={model.details} styles={styles} muted />
      ) : null}
      {settled && model.durationSeconds !== null ? (
        <DetailField
          label="Duration"
          value={formatCallElapsed(model.durationSeconds)}
          styles={styles}
        />
      ) : null}
      {model.objective ? (
        <DetailField label="Objective" value={model.objective} styles={styles} />
      ) : null}
      <View style={styles.divider} />
      {model.transcriptMarkdown ? (
        <Markdown style={markdownStyles}>{model.transcriptMarkdown}</Markdown>
      ) : (
        <Text style={styles.meta}>{emptyTranscriptText(model.phase)}</Text>
      )}
    </ScrollView>
  );
}

function emptyTranscriptText(phase: PhoneCallPhase): string {
  switch (phase) {
    case 'connecting':
      return 'The transcript starts when the call connects.';
    case 'live':
    case 'held':
      return 'Nothing has been said yet.';
    case 'ended':
    case 'failed':
      return 'Nothing was said on this call.';
  }
}

function DetailField({
  label,
  value,
  styles,
  muted = false,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
  muted?: boolean;
}) {
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={muted ? styles.meta : styles.fieldValue} selectable={muted}>
        {value}
      </Text>
    </View>
  );
}

/** Ticks locally between bridge updates; the bridge's duration stays the source of truth. */
function useCallElapsedSeconds(
  model: PhoneCallModel,
  receivedAt: number | undefined,
): number | null {
  const running = model.phase === 'live' || model.phase === 'held';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, receivedAt]);

  if (model.durationSeconds === null || !running) {
    return model.durationSeconds;
  }
  const sinceReceived = receivedAt === undefined ? 0 : Math.max(0, now - receivedAt);
  return model.durationSeconds + Math.floor(sinceReceived / 1000);
}

function phaseColor(theme: AppTheme, phase: PhoneCallPhase): string {
  switch (phase) {
    case 'live':
      return theme.colors.success;
    case 'held':
      return theme.colors.warning;
    case 'failed':
      return theme.colors.error;
    case 'connecting':
      return theme.colors.textSecondary;
    case 'ended':
      return theme.colors.textMuted;
  }
}

function phaseBackground(theme: AppTheme, phase: PhoneCallPhase): string {
  switch (phase) {
    case 'live':
      return theme.colors.successBg;
    case 'held':
      return theme.colors.warningBg;
    case 'failed':
      return theme.colors.errorBg;
    case 'connecting':
    case 'ended':
      return theme.colors.bgMain;
  }
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.bgItem,
      // Same inset as the composer input and queued-message dock, so the stack shares one column.
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      boxShadow: '0px 4px 10px rgba(0, 0, 0, 0.16)',
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingRight: theme.spacing.sm,
    },
    summary: {
      flex: 1,
      minWidth: 0,
      minHeight: theme.touchTarget.minimum + theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
    },
    indicator: {
      width: 30,
      height: 30,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    copy: {
      flex: 1,
      minWidth: 0,
    },
    callee: {
      ...theme.typography.label,
      fontSize: 14,
      lineHeight: 18,
      color: theme.colors.textPrimary,
    },
    status: {
      ...theme.typography.metadata,
      fontSize: 12,
      lineHeight: 16,
      // Phase color lives on the icon; small status text needs full contrast to stay glanceable.
      color: theme.colors.textSecondary,
      fontVariant: ['tabular-nums'],
    },
    statusError: {
      color: theme.colors.error,
    },
    hangup: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.error,
    },
    hangupGlyph: {
      transform: [{ rotate: '135deg' }],
    },
    dismiss: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    pressed: {
      opacity: 0.72,
    },
    details: {
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingBottom: theme.spacing.md,
    },
    field: {
      gap: 2,
    },
    fieldLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
    },
    fieldValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
    },
    meta: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.borderLight,
    },
  });
