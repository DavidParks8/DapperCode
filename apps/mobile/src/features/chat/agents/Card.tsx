import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { ScrollableRowText, SelectableMessageText } from '../message/Primitives';
import type { TimelineEntry } from '../message/types';
import { toSubAgentVisual } from '../message/timelineHelpers';
import { createStyles } from '../message/styles';

/** Reads one labelled line out of a sub-agent card body, ignoring its indentation. */
function findDetailLine(details: string[], label: string): string | undefined {
  const prefix = `${label.toLowerCase()}:`;
  return details.map((line) => line.trim()).find((line) => line.toLowerCase().startsWith(prefix));
}

/**
 * The one supporting line a sub-agent card shows above its latest activity.
 *
 * The card is a fixed height, so it has room for exactly one. What the sub-agent was asked to do,
 * or what it returned, says more than a status the heading and icon already convey.
 */
function summaryLine(details: string[], agentStatus: string | undefined): string {
  const trimmed = details.map((line) => line.trim()).filter(Boolean);
  return (
    trimmed.find(
      (line) => !/^(status|latest):/i.test(line) && !line.toLowerCase().startsWith('thread:'),
    ) ??
    findDetailLine(details, 'Status') ??
    `Status: ${agentStatus ?? 'running'}`
  );
}

export function SubAgentCard({
  idPrefix,
  entries,
  agentStatus,
  running,
  threadId,
  onOpen,
}: {
  idPrefix: string;
  entries: TimelineEntry[];
  agentStatus?: string;
  running: boolean;
  threadId: string;
  onOpen?: (threadId: string) => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const canOpen = Boolean(threadId && onOpen);

  return (
    <View style={styles.subAgentCardStack}>
      {entries.map((entry, index) => {
        const visual = toSubAgentVisual(entry.title);
        return (
          <View
            key={`${idPrefix}-subagent-${String(index)}`}
            testID={`${idPrefix}-subagent-card-${String(index)}`}
            style={[styles.subAgentCard, visual.isError && styles.subAgentCardError]}
          >
            <Pressable
              onPress={canOpen ? () => onOpen?.(threadId) : undefined}
              disabled={!canOpen}
              style={({ pressed }) => [
                styles.subAgentCardBody,
                pressed && canOpen && styles.subAgentCardBodyPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Open agent chat"
              accessibilityHint={canOpen ? 'Opens the sub-agent transcript' : undefined}
              accessibilityState={controlAccessibilityState({ disabled: !canOpen })}
              testID={`${idPrefix}-subagent-open-${String(index)}`}
            >
              <View style={styles.subAgentHeader}>
                <View style={styles.subAgentHeaderIcon}>
                  {running ? (
                    <ActivityIndicator size="small" color={theme.colors.subAgentAccent} />
                  ) : (
                    <Ionicons
                      {...decorativeAccessibilityProps}
                      name={visual.icon}
                      size={14}
                      color={
                        visual.isError ? theme.colors.statusError : theme.colors.subAgentAccent
                      }
                    />
                  )}
                </View>
                <Text style={styles.subAgentTitle} numberOfLines={1}>
                  {entry.title}
                </Text>
              </View>
              <View style={styles.subAgentDetailWrap}>
                <View style={styles.subAgentDetailRow}>
                  <SelectableMessageText style={styles.subAgentDetailLine} numberOfLines={1}>
                    {summaryLine(entry.details, agentStatus)}
                  </SelectableMessageText>
                </View>
                <View style={styles.subAgentDetailRow}>
                  <ScrollableRowText
                    style={styles.subAgentDetailLine}
                    backgroundColor={
                      visual.isError ? theme.colors.errorBg : theme.colors.subAgentBg
                    }
                    numberOfLines={1}
                    testID="subagent-latest-scroll"
                  >
                    {findDetailLine(entry.details, 'Latest') ?? 'Latest: —'}
                  </ScrollableRowText>
                </View>
              </View>
              <View style={styles.subAgentOpenHint} {...decorativeAccessibilityProps}>
                <Text style={styles.subAgentOpenHintText}>Open agent chat</Text>
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="chevron-forward"
                  size={12}
                  color={theme.colors.subAgentAccent}
                />
              </View>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
