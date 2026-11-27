import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { CallTimelineView } from './CallTimelineView';
import type { PhoneCallRecord } from './phoneCallReport';

interface PhoneCallRecordCardProps {
  record: PhoneCallRecord;
}

/**
 * Collapsible inline transcript record for settled outbound phone calls. Replaces raw post-call
 * report text so ended calls sit chronologically inside the chat without lingering in screen chrome.
 */
export function PhoneCallRecordCard({ record }: PhoneCallRecordCardProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const failed = record.status === 'failed';
  const headlineParts = [`Phone call · ${record.callee.displayName}`];
  if (record.durationLabel) {
    headlineParts.push(record.durationLabel);
  }
  const headline = headlineParts.join(' · ');
  const summary =
    record.outcomeSummary ?? record.endReason ?? (failed ? 'Call failed' : 'Call ended');

  return (
    <View style={[styles.card, failed && styles.cardFailed]} testID="phone-call-record-card">
      <Pressable
        onPress={() => {
          void feedback.selection();
          setExpanded((current) => !current);
        }}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${headline}, ${summary}`}
        accessibilityHint={expanded ? 'Hides the call transcript' : 'Shows the call transcript'}
        accessibilityState={controlAccessibilityState({ expanded })}
        testID="phone-call-record-toggle"
      >
        <View style={[styles.iconWrap, failed && styles.iconWrapFailed]}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={failed ? 'alert-circle-outline' : 'call-outline'}
            size={15}
            color={failed ? theme.colors.error : theme.colors.textSecondary}
          />
        </View>
        <View style={styles.copy}>
          <Text style={styles.headline} numberOfLines={1}>
            {headline}
          </Text>
          <Text style={[styles.summary, failed && styles.summaryFailed]} numberOfLines={2}>
            {summary}
          </Text>
        </View>
        <View style={styles.trailing}>
          <Text style={styles.actionCue}>{expanded ? 'Hide' : 'Transcript'}</Text>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={15}
            color={theme.colors.textMuted}
          />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.body} testID="phone-call-record-body">
          <View style={styles.divider} />
          <CallTimelineView
            items={record.timeline}
            emptyText="Nothing was said on this call."
            testID="phone-call-record-timeline"
          />
          <RecordDetailsDisclosure
            record={record}
            detailsOpen={detailsOpen}
            onToggle={() => {
              void feedback.selection();
              setDetailsOpen((current) => !current);
            }}
            styles={styles}
            theme={theme}
          />
        </View>
      ) : null}
    </View>
  );
}

function RecordDetailsDisclosure({
  record,
  detailsOpen,
  onToggle,
  styles,
  theme,
}: {
  record: PhoneCallRecord;
  detailsOpen: boolean;
  onToggle: () => void;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const hasSecondaryDetails = Boolean(
    record.objective ||
    (record.callee.name && record.callee.formattedNumber) ||
    (record.outcomeSummary && record.endReason),
  );
  if (!hasSecondaryDetails) {
    return null;
  }
  return (
    <View style={styles.detailsSection}>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [styles.detailsToggle, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Call details"
        accessibilityState={controlAccessibilityState({ expanded: detailsOpen })}
        testID="phone-call-record-details-toggle"
      >
        <Text style={styles.detailsToggleLabel}>Call details</Text>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={detailsOpen ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={theme.colors.textMuted}
        />
      </Pressable>
      {detailsOpen ? (
        <View style={styles.detailsBox} testID="phone-call-record-details">
          {record.callee.name && record.callee.formattedNumber ? (
            <DetailRow label="Number" value={record.callee.formattedNumber} styles={styles} />
          ) : null}
          {record.endReason ? (
            <DetailRow label="Outcome" value={record.endReason} styles={styles} />
          ) : null}
          {record.objective ? (
            <DetailRow label="Objective" value={record.objective} styles={styles} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function DetailRow({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    card: {
      width: '100%',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.bgItem,
      overflow: 'hidden',
    },
    cardFailed: {
      borderColor: theme.colors.error,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm + 2,
      minHeight: theme.touchTarget.minimum + 8,
    },
    iconWrap: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.bgMain,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconWrapFailed: {
      backgroundColor: theme.colors.errorBg,
    },
    copy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    headline: {
      ...theme.typography.label,
      fontSize: 13,
      lineHeight: 18,
      color: theme.colors.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    summary: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    summaryFailed: {
      color: theme.colors.error,
    },
    trailing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      flexShrink: 0,
    },
    actionCue: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.78,
    },
    body: {
      paddingHorizontal: theme.spacing.md,
      paddingBottom: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.borderLight,
    },
    detailsSection: {
      paddingTop: theme.spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.borderLight,
      gap: theme.spacing.xs,
    },
    detailsToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: theme.touchTarget.minimum,
    },
    detailsToggleLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontWeight: '600',
    },
    detailsBox: {
      gap: theme.spacing.xs + 2,
      paddingTop: 2,
    },
    detailRow: {
      gap: 2,
    },
    detailLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
    },
    detailValue: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
    },
  });
