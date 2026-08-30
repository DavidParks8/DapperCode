import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps } from 'react';
import { Text, View } from 'react-native';

import type { BridgeScheduledPrompt } from '@bridge/types/types';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { createStyles } from '../styles/styles';

type ScheduledPromptIcon = ComponentProps<typeof Ionicons>['name'];

interface ScheduledPromptDockProps {
  scheduledPrompts: readonly BridgeScheduledPrompt[];
  now?: Date;
  locale?: string;
}

function compareScheduledPrompts(
  left: BridgeScheduledPrompt,
  right: BridgeScheduledPrompt,
): number {
  return (
    Date.parse(left.scheduledFor) - Date.parse(right.scheduledFor) ||
    left.scheduleId.localeCompare(right.scheduleId)
  );
}

export function selectEarliestScheduledPrompt(
  scheduledPrompts: readonly BridgeScheduledPrompt[],
): BridgeScheduledPrompt | null {
  return [...scheduledPrompts].sort(compareScheduledPrompts)[0] ?? null;
}

function localDayIndex(value: Date): number {
  return Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000);
}

export function formatScheduledPromptTime(
  scheduledFor: string,
  now = new Date(),
  locale?: string,
): string {
  const scheduled = new Date(scheduledFor);
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(scheduled);
  const dayDifference = localDayIndex(scheduled) - localDayIndex(now);
  if (dayDifference === 0 || dayDifference === 1) {
    return `${dayDifference === 0 ? 'Today' : 'Tomorrow'}, ${time}`;
  }
  return new Intl.DateTimeFormat(locale, {
    year: scheduled.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(scheduled);
}

export function scheduledPromptStatusPresentation(
  prompt: BridgeScheduledPrompt,
  now = new Date(),
  locale?: string,
): { icon: ScheduledPromptIcon; label: string } {
  const time = formatScheduledPromptTime(prompt.scheduledFor, now, locale);
  switch (prompt.status) {
    case 'queued':
      return { icon: 'time-outline', label: `Queued for delivery · ${time}` };
    case 'retrying':
      return { icon: 'refresh-outline', label: `Retrying delivery · ${time}` };
    default:
      return { icon: 'calendar-outline', label: `Scheduled for ${time}` };
  }
}

export function ScheduledPromptDock({
  scheduledPrompts,
  now = new Date(),
  locale,
}: ScheduledPromptDockProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const scheduledPrompt = selectEarliestScheduledPrompt(scheduledPrompts);
  if (!scheduledPrompt) {
    return null;
  }

  const remainingCount = scheduledPrompts.length - 1;
  const preview = scheduledPrompt.promptPreview.replace(/\s+/g, ' ').trim();
  const presentation = scheduledPromptStatusPresentation(scheduledPrompt, now, locale);
  const moreLabel = remainingCount > 0 ? `+${String(remainingCount)} more` : null;
  const accessibilityLabel = ['Scheduled prompt', presentation.label, preview, moreLabel]
    .filter(Boolean)
    .join('. ');

  return (
    <View style={styles.queuedMessageDock} accessibilityLiveRegion="polite">
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={[styles.planCard, styles.planOverlayCard, styles.queuedMessageCard]}
      >
        <View style={styles.scheduledPromptRow}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={presentation.icon}
            size={18}
            color={theme.colors.textMuted}
          />
          <View style={styles.scheduledPromptContent}>
            <View style={styles.scheduledPromptHeader}>
              <Text numberOfLines={1} style={styles.scheduledPromptTitle}>
                {presentation.label}
              </Text>
              {moreLabel ? (
                <Text numberOfLines={1} style={styles.scheduledPromptSummary}>
                  {moreLabel}
                </Text>
              ) : null}
            </View>
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.scheduledPromptPreview}>
              {preview}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}
