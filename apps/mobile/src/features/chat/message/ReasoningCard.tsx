import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, Text, View, type TextLayoutEvent } from 'react-native';
import Markdown from 'react-native-markdown-display';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { motionDuration } from '@shared/ui/motion';
import type { createMarkdownRules } from './markdownRules';
import { createReasoningMarkdownStyles } from './markdownStyles';
import { SelectableMessageText } from './Primitives';
import { createStyles } from './styles';
import { stripMarkdownInline } from '../helpers/timeline';
import { summarizeReasoningPreview } from './timelineHelpers';
import type { TimelineEntry } from './types';

export const REASONING_PREVIEW_LINES = 3;

interface PreviewMeasurement {
  text: string;
  clipped: boolean;
}

function resolveReasoningClipped(
  measurement: PreviewMeasurement | null,
  preview: string | null,
): boolean {
  if (measurement !== null && measurement.text === preview) {
    return measurement.clipped;
  }
  return measurement?.clipped ?? false;
}

function ReasoningCardHeader({
  title,
  canToggle,
  showDetails,
  theme,
  styles,
}: {
  title: string;
  canToggle: boolean;
  showDetails: boolean;
  theme: ReturnType<typeof useAppTheme>;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.reasoningHeader}>
      <Ionicons
        {...decorativeAccessibilityProps}
        name="bulb-outline"
        size={13}
        color={theme.colors.textMuted}
      />
      <Text style={styles.reasoningTitle}>{title}</Text>
      {canToggle ? (
        <Ionicons
          {...decorativeAccessibilityProps}
          name={showDetails ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={theme.colors.textMuted}
        />
      ) : null}
    </View>
  );
}

function ReasoningCardPreview({
  preview,
  pending,
  showDetails,
  onPreviewTextLayout,
  styles,
}: {
  preview: string | null;
  pending: boolean;
  showDetails: boolean;
  onPreviewTextLayout: (event: TextLayoutEvent) => void;
  styles: ReturnType<typeof createStyles>;
}) {
  if (!pending || showDetails || !preview) {
    return null;
  }
  return (
    <View>
      <SelectableMessageText
        style={styles.reasoningPreview}
        numberOfLines={REASONING_PREVIEW_LINES}
      >
        {preview}
      </SelectableMessageText>
      <Text
        {...decorativeAccessibilityProps}
        style={[styles.reasoningPreview, styles.reasoningPreviewMeasure]}
        onTextLayout={onPreviewTextLayout}
      >
        {preview}
      </Text>
    </View>
  );
}

function ReasoningCardDetails({
  entry,
  showDetails,
  styles,
  markdownStyles,
  markdownRules,
}: {
  entry: TimelineEntry;
  showDetails: boolean;
  styles: ReturnType<typeof createStyles>;
  markdownStyles: ReturnType<typeof createReasoningMarkdownStyles>;
  markdownRules: ReturnType<typeof createMarkdownRules>;
}) {
  if (!showDetails) {
    return null;
  }
  return (
    <Animated.View
      entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
      style={styles.reasoningDetailWrap}
    >
      <Markdown style={markdownStyles} rules={markdownRules}>
        {entry.details.join('\n')}
      </Markdown>
    </Animated.View>
  );
}

export function ReasoningEntryCard({
  entry,
  pending,
  markdownRules,
}: {
  entry: TimelineEntry;
  pending: boolean;
  markdownRules: ReturnType<typeof createMarkdownRules>;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const [measurement, setMeasurement] = useState<PreviewMeasurement | null>(null);

  const rawPreview = entry.details.length > 0 ? summarizeReasoningPreview(entry.details) : null;
  const preview = rawPreview ? stripMarkdownInline(rawPreview) : null;
  const markdownStyles = useMemo(() => createReasoningMarkdownStyles(theme), [theme]);
  // While a changed preview is re-measured, keep the previous result so the
  // toggle affordance does not flicker mid-stream.
  const clipped = resolveReasoningClipped(measurement, preview);
  const canToggle = preview !== null && (!pending || clipped);
  const showDetails = expanded && canToggle;

  const onPreviewTextLayout = (event: TextLayoutEvent) => {
    if (preview === null) {
      return;
    }
    const clippedNow = event.nativeEvent.lines.length > REASONING_PREVIEW_LINES;
    setMeasurement((previous) =>
      previous?.text === preview && previous.clipped === clippedNow
        ? previous
        : { text: preview, clipped: clippedNow },
    );
  };

  return (
    <Animated.View
      layout={LinearTransition.duration(motionDuration.layout).reduceMotion(ReduceMotion.System)}
    >
      <Pressable
        disabled={!canToggle}
        onPress={() => setExpanded((previous) => !previous)}
        style={({ pressed }) => [
          styles.reasoningCard,
          canToggle && styles.reasoningCardInteractive,
          pressed && canToggle && styles.reasoningCardPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={entry.title}
        accessibilityHint={
          canToggle ? `${showDetails ? 'Hides' : 'Shows'} reasoning details` : undefined
        }
        accessibilityState={controlAccessibilityState({
          disabled: !canToggle,
          expanded: canToggle ? showDetails : undefined,
        })}
      >
        <ReasoningCardHeader
          title={entry.title}
          canToggle={canToggle}
          showDetails={showDetails}
          theme={theme}
          styles={styles}
        />
        <ReasoningCardPreview
          preview={preview}
          pending={pending}
          showDetails={showDetails}
          onPreviewTextLayout={onPreviewTextLayout}
          styles={styles}
        />
        <ReasoningCardDetails
          entry={entry}
          showDetails={showDetails}
          styles={styles}
          markdownStyles={markdownStyles}
          markdownRules={markdownRules}
        />
        {pending && canToggle ? (
          <Text style={styles.reasoningToggleText}>
            {showDetails ? 'Tap to hide thinking' : 'Tap to show thinking'}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
