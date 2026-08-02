import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ReactElement } from 'react';
import { Text, View } from 'react-native';

import { decorativeAccessibilityProps } from '../accessibility';
import { useAppTheme } from '../theme';
import { computerUseActionIconName, parseComputerUseTraceEntry } from './computerUseTrace';
import { toTimelineDetailPreview } from './chatMessageContentHelpers';
import { MarkdownImage } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import type { TimelineDetailPreview, ToolGroupEntry } from './chatMessageTypes';

export function ComputerUseTimeline({
  entries,
  bridgeUrl,
  bridgeToken,
}: {
  entries: ToolGroupEntry[];
  bridgeUrl: string | null;
  bridgeToken: string | null;
}): ReactElement | null {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const parsedEntries = entries
    .map((entry) => {
      const parsed = parseComputerUseTraceEntry(entry);
      return parsed
        ? { entry, parsed, detailPreview: toTimelineDetailPreview(entry, bridgeUrl, bridgeToken) }
        : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        entry: ToolGroupEntry;
        parsed: NonNullable<ReturnType<typeof parseComputerUseTraceEntry>>;
        detailPreview: TimelineDetailPreview;
      } => entry !== null,
    );
  if (parsedEntries.length === 0) {
    return null;
  }

  return (
    <View
      style={[
        styles.messageWrapper,
        styles.messageWrapperAssistant,
        styles.messageWrapperFullWidth,
      ]}
    >
      <View style={styles.computerUseTrace}>
        {parsedEntries.length > 1 ? (
          <View style={styles.computerUseTraceSummaryRow}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="desktop-outline"
              size={14}
              color={theme.colors.textMuted}
            />
            <Text
              style={styles.computerUseTraceSummaryText}
            >{`${String(parsedEntries.length)} actions`}</Text>
          </View>
        ) : null}
        <View style={styles.computerUseTraceStepList}>
          {parsedEntries.map(({ entry, parsed, detailPreview }) => (
            <View key={entry.id} style={styles.computerUseTraceStep}>
              <View style={styles.computerUseTraceStepBody}>
                <View style={styles.computerUseTraceStepTopRow}>
                  <Ionicons
                    name={computerUseActionIconName(parsed.actionKey)}
                    size={13}
                    color={theme.colors.textMuted}
                  />
                  <Text style={styles.computerUseTraceAction}>{parsed.actionLabel}</Text>
                  {parsed.appName ? (
                    <Text style={styles.computerUseTraceInlineMeta} numberOfLines={1}>
                      {parsed.appName}
                    </Text>
                  ) : null}
                </View>
                {detailPreview.images.map((image, index) => (
                  <MarkdownImage
                    key={`${entry.id}-computer-use-image-${String(index)}`}
                    source={image.source}
                    accessibilityLabel={image.accessibilityLabel}
                  />
                ))}
                {!detailPreview.images.length && parsed.windowTitle ? (
                  <Text style={styles.computerUseTraceInlineMeta} numberOfLines={1}>
                    {parsed.windowTitle}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
