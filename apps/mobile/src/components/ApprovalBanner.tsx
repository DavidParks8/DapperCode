import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { useEffect, useMemo, useState } from 'react';

import type { PendingApproval } from '../api/types';
import { useAppTheme, type AppTheme } from '../theme';
import { feedback } from '../feedback';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
} from '../accessibility';
import { computeHitSlop } from './touchTarget';
import { motionDuration } from './motion';

interface ApprovalBannerProps {
  approval: PendingApproval;
  onResolve: (id: string, optionId: string) => Promise<void>;
}

/** Approximate visible height of an action button, used to size its touch-target hitSlop. */
const ACTION_BUTTON_VISIBLE_HEIGHT = 34;

export function ApprovalBanner({ approval, onResolve }: ApprovalBannerProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const actionButtonHitSlop = useMemo(
    () => computeHitSlop({ width: 112, height: ACTION_BUTTON_VISIBLE_HEIGHT }),
    [],
  );

  // A remounted or reused card must not carry a stale error from the approval it replaced.
  useEffect(() => {
    setResolutionError(null);
  }, [approval.requestId]);

  const handleResolve = async (optionId: string, destructive: boolean) => {
    setResolutionError(null);
    try {
      await runApprovalResolution(approval.requestId, optionId, onResolve, setResolving);
      // Fire the semantic haptic only after the bridge round-trip succeeds; the parent screen
      // does not fire its own haptic for this action, so this is the single source of truth.
      void (destructive ? feedback.warning() : feedback.success());
    } catch (err) {
      void feedback.error();
      // The parent screen may also surface this in a global error banner, but the card must
      // not depend on that: it renders its own visible error so retrying is never a guess.
      setResolutionError(err instanceof Error ? err.message : 'Failed to resolve approval.');
    }
  };

  const label =
    approval.kind === 'commandExecution' ? (approval.command ?? 'Run command') : 'File change';
  useAccessibilityAnnouncement(
    resolving
      ? `Resolving approval: ${resolving}`
      : (resolutionError ?? `Approval requested. ${label}`),
  );

  return (
    <Animated.View
      entering={FadeInDown.duration(motionDuration.layout).reduceMotion(ReduceMotion.System)}
      style={styles.container}
      accessibilityLiveRegion="assertive"
    >
      <View style={styles.header}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name="shield-checkmark-outline"
          size={16}
          color={colors.accent}
        />
        <Text style={styles.title}>Approval requested</Text>
      </View>

      <Text style={styles.command} numberOfLines={3}>
        {label}
      </Text>

      {approval.reason ? (
        <Text style={styles.reason} numberOfLines={2}>
          {approval.reason}
        </Text>
      ) : null}

      {resolutionError ? (
        <Text style={styles.resolutionError} accessibilityRole="alert">
          {resolutionError}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {approval.options.map((option) => {
          const destructive = option.kind?.toLowerCase().includes('reject') ?? false;
          return (
            <Pressable
              key={option.id}
              style={({ pressed }) => [
                styles.btn,
                destructive ? styles.denyBtn : styles.acceptBtn,
                pressed && styles.btnPressed,
              ]}
              onPress={() => void handleResolve(option.id, destructive)}
              disabled={resolving !== null}
              hitSlop={actionButtonHitSlop}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={controlAccessibilityState({
                disabled: resolving !== null,
                busy: resolving === option.id,
              })}
            >
              {resolving === option.id ? (
                <ActivityIndicator
                  size="small"
                  color={destructive ? colors.error : colors.textPrimary}
                />
              ) : (
                <>
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name={destructive ? 'close' : 'checkmark'}
                    size={14}
                    color={destructive ? colors.error : colors.textPrimary}
                  />
                  <Text
                    style={[
                      styles.btnText,
                      { color: destructive ? colors.error : colors.textPrimary },
                    ]}
                  >
                    {option.label}
                  </Text>
                </>
              )}
            </Pressable>
          );
        })}
      </View>
    </Animated.View>
  );
}

export async function runApprovalResolution(
  id: string,
  optionId: string,
  resolve: (id: string, optionId: string) => Promise<void>,
  setResolving: (value: string | null) => void,
): Promise<void> {
  setResolving(optionId);
  try {
    await resolve(id, optionId);
  } finally {
    setResolving(null);
  }
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      backgroundColor: theme.colors.bgItem,
      borderWidth: 1,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
    },
    title: {
      ...theme.typography.caption,
      color: theme.colors.accent,
      fontWeight: '600',
    },
    command: {
      ...theme.typography.mono,
      color: theme.colors.textPrimary,
      backgroundColor: theme.colors.bgItem,
      borderRadius: theme.radius.sm,
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
      overflow: 'hidden',
    },
    reason: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.sm,
    },
    resolutionError: {
      ...theme.typography.caption,
      color: theme.colors.error,
      marginBottom: theme.spacing.sm,
    },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    btn: {
      flexGrow: 1,
      minWidth: 112,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.radius.sm,
      borderWidth: 1,
    },
    btnPressed: {
      opacity: 0.7,
    },
    denyBtn: {
      borderColor: theme.colors.errorBorder,
      backgroundColor: theme.colors.errorBg,
    },
    acceptBtn: {
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgInput,
    },
    allowSimilarBtn: {
      flexBasis: '100%',
    },
    btnText: {
      ...theme.typography.caption,
      fontWeight: '600',
    },
  });
