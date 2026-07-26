import { Ionicons } from '@expo/vector-icons';
import { Fragment, memo, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { getMessageText, getToolCallDisplayLines } from '../api/messages';
import { useAppTheme } from '../theme';
import { ComputerUseTimeline } from './chatMessageComputerUse';
import { isViewedImageEntry, toTimelineDetailPreview } from './chatMessageContentHelpers';
import { MarkdownImage, ScrollableRowText, SelectableMessageText } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import {
  entriesAreComputerUseTimeline,
  parseTimelineEntries,
  summarizeToolGroup,
  toTimelineVisual,
} from './chatMessageTimelineHelpers';
import type { ToolActivityGroupProps, ToolGroupEntry } from './chatMessageTypes';

const COLLAPSED_PREVIEW_COUNT = 2;
const EXPANDED_LIST_MAX_HEIGHT = 300;
const EXPANDED_LIST_MAX_HEIGHT_RATIO = 0.38;
const DETAIL_LINES_SCROLL_THRESHOLD = 24;

export const ToolActivityGroup = memo(function ToolActivityGroupComponent({
  messages,
  bridgeUrl = null,
  bridgeToken = null,
  liveTurnActive = false,
}: ToolActivityGroupProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { height: windowHeight } = useWindowDimensions();
  const maxHeight = Math.min(
    EXPANDED_LIST_MAX_HEIGHT,
    Math.floor(windowHeight * EXPANDED_LIST_MAX_HEIGHT_RATIO),
  );
  const [expanded, setExpanded] = useState(false);
  const [expandedEntryIds, setExpandedEntryIds] = useState<Record<string, boolean>>({});
  const entries = useMemo(() => {
    const flattened: ToolGroupEntry[] = [];
    for (const message of messages) {
      const lines = getToolCallDisplayLines(message);
      if (lines.length > 0) {
        lines.forEach((line, index) => {
          const parsed = parseTimelineEntries(line)?.[0];
          flattened.push({
            id: `${message.id}-tool-call-${String(index)}`,
            title: parsed?.title ?? line,
            details: parsed?.details ?? [],
          });
        });
        continue;
      }
      const parsed = parseTimelineEntries(getMessageText(message));
      if (parsed?.length) {
        parsed.forEach((entry, index) =>
          flattened.push({ ...entry, id: `${message.id}-${String(index)}` }),
        );
        continue;
      }
      flattened.push({ id: message.id, title: getMessageText(message).trim(), details: [] });
    }
    return flattened.filter((entry) => entry.title.length > 0);
  }, [messages]);
  const toggleExpanded = useCallback(() => setExpanded((previous) => !previous), []);
  if (entries.length === 0) return null;
  if (entriesAreComputerUseTimeline(entries))
    return (
      <ComputerUseTimeline entries={entries} bridgeUrl={bridgeUrl} bridgeToken={bridgeToken} />
    );

  const previewEntries = expanded ? entries : entries.slice(0, COLLAPSED_PREVIEW_COUNT);
  const hiddenCount = Math.max(entries.length - previewEntries.length, 0);
  const summary = summarizeToolGroup(entries.map((entry) => entry.title));
  const listInner = (
    <>
      {previewEntries.map((entry, entryIndex) => {
        const preview = toTimelineDetailPreview(entry, bridgeUrl, bridgeToken);
        const hasImages = preview.images.length > 0;
        const hasDetails = preview.textDetails.length > 0;
        const entryExpanded = expandedEntryIds[entry.id] === true;
        const visual = toTimelineVisual(entry.title);
        if (!expanded) {
          const previewImage = preview.images[0] ?? null;
          return (
            <View key={entry.id} style={styles.toolGroupPreviewEntry}>
              <View style={styles.toolGroupRow}>
                <Ionicons
                  name={visual.icon}
                  size={13}
                  color={visual.isError ? theme.colors.statusError : theme.colors.textMuted}
                  style={styles.toolGroupPreviewIcon}
                />
                {visual.useMonospaceTitle ? (
                  <ScrollableRowText
                    style={styles.toolGroupRowText}
                    backgroundColor={theme.colors.bgItem}
                    testID="tool-command-scroll"
                  >
                    {entry.title}
                  </ScrollableRowText>
                ) : (
                  <Text style={styles.toolGroupRowText} numberOfLines={1}>
                    {entry.title}
                  </Text>
                )}
              </View>
              {previewImage ? (
                <View style={styles.toolGroupPreviewImageClip}>
                  <MarkdownImage
                    key={`${entry.id}-preview-image`}
                    source={previewImage.source}
                    accessibilityLabel={previewImage.accessibilityLabel}
                  />
                </View>
              ) : null}
            </View>
          );
        }
        return (
          <Fragment key={entry.id}>
            <Pressable
              disabled={!hasDetails}
              onPress={() =>
                hasDetails &&
                setExpandedEntryIds((previous) => ({
                  ...previous,
                  [entry.id]: !previous[entry.id],
                }))
              }
              style={({ pressed }) => [
                styles.toolGroupEntryCard,
                hasDetails && styles.toolGroupEntryCardInteractive,
                visual.isError && styles.timelineCardError,
                pressed && hasDetails && styles.toolGroupEntryCardPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={entry.title}
              accessibilityHint={
                hasDetails ? `${entryExpanded ? 'Hides' : 'Shows'} tool output` : undefined
              }
              accessibilityState={controlAccessibilityState({
                disabled: !hasDetails,
                expanded: hasDetails ? entryExpanded : undefined,
              })}
            >
              <View style={styles.toolGroupEntryHeader}>
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name={visual.icon}
                  size={14}
                  color={visual.isError ? theme.colors.statusError : theme.colors.statusRunning}
                />
                {visual.useMonospaceTitle && !entryExpanded ? (
                  <ScrollableRowText
                    style={[styles.toolGroupEntryTitle, styles.toolGroupEntryTitleMono]}
                    backgroundColor={theme.colors.bgItem}
                    testID="tool-command-scroll"
                  >
                    {entry.title}
                  </ScrollableRowText>
                ) : (
                  <Text
                    style={[
                      styles.toolGroupEntryTitle,
                      visual.useMonospaceTitle && styles.toolGroupEntryTitleMono,
                    ]}
                    numberOfLines={entryExpanded ? 3 : 1}
                  >
                    {entry.title}
                  </Text>
                )}
                {hasDetails ? (
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name={entryExpanded ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={theme.colors.textMuted}
                  />
                ) : null}
              </View>
              {hasDetails ? (
                <Text style={styles.toolGroupEntryToggleText}>
                  {hasImages && isViewedImageEntry(entry.title, preview.textDetails)
                    ? entryExpanded
                      ? 'Tap to hide path'
                      : 'Tap to show path'
                    : entryExpanded
                      ? 'Tap to hide output'
                      : preview.textDetails.length <= 1
                        ? 'Tap to show output'
                        : `Tap to show ${String(preview.textDetails.length)} lines`}
                </Text>
              ) : null}
              {preview.images.map((image, index) => (
                <MarkdownImage
                  key={`${entry.id}-image-${String(index)}`}
                  source={image.source}
                  accessibilityLabel={image.accessibilityLabel}
                />
              ))}
              {entryExpanded && hasDetails ? (
                preview.textDetails.length > DETAIL_LINES_SCROLL_THRESHOLD ? (
                  <ScrollView
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator
                    style={[
                      styles.toolGroupEntryDetailScroll,
                      styles.toolGroupEntryDetailWrapOffset,
                    ]}
                  >
                    <View style={styles.toolGroupEntryDetailSurface}>
                      {preview.textDetails.map((line, index) => (
                        <SelectableMessageText
                          key={`${entry.id}-line-${String(index)}`}
                          style={styles.toolGroupEntryDetailLine}
                        >
                          {line}
                        </SelectableMessageText>
                      ))}
                    </View>
                  </ScrollView>
                ) : (
                  <View
                    style={[
                      styles.toolGroupEntryDetailWrapOffset,
                      styles.toolGroupEntryDetailSurface,
                    ]}
                  >
                    {preview.textDetails.map((line, index) => (
                      <SelectableMessageText
                        key={`${entry.id}-line-${String(index)}`}
                        style={styles.toolGroupEntryDetailLine}
                      >
                        {line}
                      </SelectableMessageText>
                    ))}
                  </View>
                )
              ) : null}
            </Pressable>
            {entryIndex < previewEntries.length - 1 ? (
              <View style={styles.toolGroupEntryDivider} />
            ) : null}
          </Fragment>
        );
      })}
      {!expanded && hiddenCount > 0 ? (
        <Text style={styles.toolGroupMoreText}>{`+${String(hiddenCount)} more`}</Text>
      ) : null}
    </>
  );

  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <View style={[styles.toolGroupCard, liveTurnActive && styles.toolGroupCardLive]}>
        <View style={styles.toolGroupEyebrowRow}>
          <View style={styles.toolGroupEyebrowLeft}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="hardware-chip-outline"
              size={12}
              color={theme.colors.textMuted}
            />
            <Text style={styles.toolGroupEyebrowText}>Tools</Text>
          </View>
        </View>
        <Pressable
          onPress={toggleExpanded}
          style={({ pressed }) => [
            styles.toolGroupHeaderPressable,
            styles.toolGroupCardInteractive,
            pressed && styles.toolGroupCardPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`${summary}, tools`}
          accessibilityHint={`${expanded ? 'Collapses' : 'Expands'} tool activity`}
          accessibilityState={controlAccessibilityState({ expanded })}
        >
          <View style={styles.toolGroupHeader}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="chevron-expand-outline"
              size={14}
              color={theme.colors.textMuted}
            />
            <Text style={styles.toolGroupTitle}>{summary}</Text>
            <Ionicons
              {...decorativeAccessibilityProps}
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={theme.colors.textMuted}
            />
          </View>
        </Pressable>
        {expanded ? (
          <ScrollView
            style={{ maxHeight }}
            contentContainerStyle={styles.toolGroupListScrollContent}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <View style={styles.toolGroupList}>{listInner}</View>
          </ScrollView>
        ) : (
          <View style={styles.toolGroupList}>{listInner}</View>
        )}
      </View>
    </View>
  );
});
ToolActivityGroup.displayName = 'ToolActivityGroup';
