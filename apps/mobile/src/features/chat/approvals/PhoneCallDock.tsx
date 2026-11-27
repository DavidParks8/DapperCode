import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { BridgeUiSurface } from '@bridge/types/types';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
} from '@shared/accessibility';
import { getBridgeUiSurfaceReceivedAt } from '../helpers/bridgeUi';
import {
  activityBackground,
  activityColor,
  activityIconName,
  useCallElapsedSeconds,
} from '../phoneCall/phoneCallVisuals';
import type { BridgeUiActionHandler } from './SurfaceRenderers';
import { phoneCallModel, phoneCallStatusLine, type HangupState } from './phoneCallModel';

interface PhoneCallDockProps {
  surface: BridgeUiSurface;
  stageOpen?: boolean;
  onOpenStage?: (surface: BridgeUiSurface) => void;
  onAction: BridgeUiActionHandler;
  onDismiss: (surface: BridgeUiSurface) => void;
}

/**
 * Ambient 1-row Live Call Pill docked cleanly above the composer inside the message column.
 * Never expands inline over the transcript; tapping opens the dedicated Live Call Stage
 * (sheet on compact/laptop poses, trailing side pane on iPhone Duo Book / Open wide poses).
 */
export function PhoneCallDock({
  surface,
  stageOpen = false,
  onOpenStage,
  onAction,
  onDismiss,
}: PhoneCallDockProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const model = useMemo(() => phoneCallModel(surface), [surface]);
  const [hangup, setHangup] = useState<HangupState>('idle');
  const elapsed = useCallElapsedSeconds(model, getBridgeUiSurfaceReceivedAt(surface));
  const statusLine = phoneCallStatusLine(model, elapsed, hangup);
  const accent = activityColor(theme, model.phase, model.activityKind);
  const badgeBg = activityBackground(theme, model.phase, model.activityKind);
  const iconName = activityIconName(model.phase, model.activityKind);
  const hangupAction = model.hangupAction;
  const settled = model.phase === 'ended' || model.phase === 'failed';

  // Announce state changes and the outcome, never each tick of the timer.
  useAccessibilityAnnouncement(
    `${model.calleeDisplay.displayName}: ${settled || hangup !== 'idle' ? statusLine : (model.activityLabel ?? model.status)}`,
  );

  useEffect(() => {
    if (!hangupAction) {
      setHangup('idle');
    }
  }, [hangupAction]);

  return (
    <View style={[styles.card, stageOpen && styles.cardActive]} testID="phone-call-dock">
      <View style={styles.row}>
        <Pressable
          onPress={() => {
            void feedback.selection();
            onOpenStage?.(surface);
          }}
          style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Phone call with ${model.calleeDisplay.displayName}, ${statusLine}`}
          accessibilityHint={
            stageOpen
              ? 'Minimizes the live call view'
              : 'Opens the live call transcript and controls'
          }
          accessibilityState={controlAccessibilityState({ expanded: stageOpen })}
          testID="phone-call-dock-toggle"
        >
          <View style={[styles.indicator, { backgroundColor: badgeBg }]}>
            {model.activityKind === 'running_tool' ? (
              <ActivityIndicator size="small" color={accent} />
            ) : (
              <Ionicons
                {...decorativeAccessibilityProps}
                name={iconName}
                size={15}
                color={accent}
              />
            )}
          </View>
          <View style={styles.copy}>
            <Text style={styles.callee} numberOfLines={1} ellipsizeMode="middle">
              {model.calleeDisplay.displayName}
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
            name={stageOpen ? 'chevron-down' : 'chevron-forward'}
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
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.full,
      borderCurve: 'continuous',
      backgroundColor: theme.colors.bgItem,
      // Same inset as the composer input and queued-message dock, so the stack shares one column.
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      boxShadow: '0px 4px 10px rgba(0, 0, 0, 0.16)',
      overflow: 'hidden',
    },
    cardActive: {
      borderColor: theme.colors.borderHighlight,
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
      paddingLeft: theme.spacing.sm + 2,
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
  });
