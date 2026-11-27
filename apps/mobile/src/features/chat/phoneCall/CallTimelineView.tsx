import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme, type AppTheme } from '@shared/theme';
import type { CallTimelineItem } from './phoneCallTimeline';

interface CallTimelineViewProps {
  items: readonly CallTimelineItem[];
  emptyText: string;
  testID?: string;
}

/**
 * Shared two-sided conversation timeline for both the Live Call Stage and expanded inline post-call
 * transcript records: recipient on the left, agent on the right, plus whispers, system events, and
 * async tool-activity chips.
 */
export function CallTimelineView({ items, emptyText, testID }: CallTimelineViewProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (items.length === 0) {
    return (
      <View style={styles.emptyWrap} testID={testID}>
        <Text style={styles.emptyText}>{emptyText}</Text>
      </View>
    );
  }

  return (
    <View style={styles.list} testID={testID}>
      {items.map((item, index) => (
        <CallTimelineRow
          key={`${item.kind}-${String(index)}`}
          item={item}
          styles={styles}
          theme={theme}
        />
      ))}
    </View>
  );
}

function CallTimelineRow({
  item,
  styles,
  theme,
}: {
  item: CallTimelineItem;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  switch (item.kind) {
    case 'recipient':
      return (
        <View style={styles.recipientRow} testID="call-timeline-recipient">
          <Text style={styles.speakerLabel}>{item.speakerLabel}</Text>
          <View style={styles.recipientBubble}>
            <Text style={styles.recipientText}>{item.text}</Text>
            {item.interrupted ? <Text style={styles.interruptedTag}>Interrupted</Text> : null}
          </View>
        </View>
      );
    case 'agent':
      return (
        <View style={styles.agentRow} testID="call-timeline-agent">
          <Text style={[styles.speakerLabel, styles.agentSpeakerLabel]}>Agent</Text>
          <View style={styles.agentBubble}>
            <Text style={styles.agentText}>{item.text}</Text>
            {item.interrupted ? <Text style={styles.agentInterruptedTag}>Interrupted</Text> : null}
          </View>
        </View>
      );
    case 'whisper':
      return (
        <View style={styles.whisperRow} testID="call-timeline-whisper">
          <View style={styles.whisperPill}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="chatbubble-ellipses-outline"
              size={13}
              color={theme.colors.accent}
            />
            <Text style={styles.whisperText}>{`Whisper: ${item.text}`}</Text>
          </View>
        </View>
      );
    case 'event':
      return (
        <View style={styles.centeredRow} testID="call-timeline-event">
          <View style={styles.eventPill}>
            <Text style={styles.eventText}>{item.text}</Text>
          </View>
        </View>
      );
    case 'tool':
      return (
        <View style={styles.centeredRow} testID="call-timeline-tool">
          <View
            style={[
              styles.toolChip,
              item.status === 'failed' && styles.toolChipFailed,
              item.status === 'running' && styles.toolChipRunning,
            ]}
          >
            {item.status === 'running' ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : (
              <Ionicons
                {...decorativeAccessibilityProps}
                name={
                  item.status === 'failed' ? 'alert-circle-outline' : 'checkmark-circle-outline'
                }
                size={14}
                color={item.status === 'failed' ? theme.colors.error : theme.colors.success}
              />
            )}
            <View style={styles.toolCopy}>
              <Text style={styles.toolLabel}>{item.label}</Text>
              {item.detail ? <Text style={styles.toolDetail}>{item.detail}</Text> : null}
            </View>
          </View>
        </View>
      );
    case 'omitted':
      return (
        <View style={styles.centeredRow}>
          <Text style={styles.omittedText}>{item.text}</Text>
        </View>
      );
  }
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    list: {
      gap: theme.spacing.sm + 2,
    },
    emptyWrap: {
      paddingVertical: theme.spacing.lg,
      alignItems: 'center',
    },
    emptyText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    recipientRow: {
      alignSelf: 'flex-start',
      maxWidth: '86%',
      gap: 3,
    },
    agentRow: {
      alignSelf: 'flex-end',
      alignItems: 'flex-end',
      maxWidth: '86%',
      gap: 3,
    },
    speakerLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      paddingHorizontal: theme.spacing.xs,
    },
    agentSpeakerLabel: {
      textAlign: 'right',
    },
    recipientBubble: {
      backgroundColor: theme.colors.bgCanvasAccent,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.radius.lg,
      borderTopLeftRadius: theme.radius.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: 4,
    },
    recipientText: {
      ...theme.typography.body,
      fontSize: 14,
      lineHeight: 20,
      color: theme.colors.textPrimary,
    },
    agentBubble: {
      backgroundColor: theme.colors.userBubble,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.userBubbleBorder,
      borderRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: 4,
    },
    agentText: {
      ...theme.typography.body,
      fontSize: 14,
      lineHeight: 20,
      color: theme.colors.userBubbleText,
    },
    interruptedTag: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontStyle: 'italic',
    },
    agentInterruptedTag: {
      ...theme.typography.metadata,
      color: theme.colors.userBubbleSecondaryText,
      fontStyle: 'italic',
    },
    whisperRow: {
      alignSelf: 'flex-end',
      maxWidth: '90%',
    },
    whisperPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgElevated,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.sm + 2,
      paddingVertical: theme.spacing.xs + 1,
    },
    whisperText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      flexShrink: 1,
    },
    centeredRow: {
      alignItems: 'center',
    },
    eventPill: {
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.bgCanvasAccent,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      paddingHorizontal: theme.spacing.sm + 2,
      paddingVertical: 3,
    },
    eventText: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
    },
    toolChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs + 2,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.bgItem,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      paddingHorizontal: theme.spacing.sm + 2,
      paddingVertical: theme.spacing.xs + 2,
      maxWidth: '92%',
    },
    toolChipRunning: {
      borderColor: theme.colors.borderHighlight,
    },
    toolChipFailed: {
      borderColor: theme.colors.error,
      backgroundColor: theme.colors.errorBg,
    },
    toolCopy: {
      flexShrink: 1,
      gap: 1,
    },
    toolLabel: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      fontWeight: '600',
    },
    toolDetail: {
      ...theme.typography.metadata,
      color: theme.colors.textSecondary,
    },
    omittedText: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontStyle: 'italic',
    },
  });
