import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { useAppTheme } from '../theme';
import { motionDuration } from './motion';
import { SelectableMessageText } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import { summarizeReasoningPreview } from './chatMessageTimelineHelpers';
import type { TimelineEntry } from './chatMessageTypes';

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
        name="sparkles-outline"
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
  showDetails,
  onPreviewTextLayout,
  styles,
}: {
  preview: string | null;
  showDetails: boolean;
  onPreviewTextLayout: (event: NativeSyntheticEvent<TextLayoutEventData>) => void;
  styles: ReturnType<typeof createStyles>;
}) {
  if (showDetails || !preview) {
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
}: {
  entry: TimelineEntry;
  showDetails: boolean;
  styles: ReturnType<typeof createStyles>;
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
      {entry.details.map((line, lineIndex) => (
        <SelectableMessageText
          key={`reasoning-line-${String(lineIndex)}`}
          style={styles.reasoningDetailLine}
        >
          {line}
        </SelectableMessageText>
      ))}
    </Animated.View>
  );
}

export function ReasoningEntryCard({ entry }: { entry: TimelineEntry }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const [measurement, setMeasurement] = useState<PreviewMeasurement | null>(null);

  const preview = entry.details.length > 0 ? summarizeReasoningPreview(entry.details) : null;
  // While a changed preview is re-measured, keep the previous result so the
  // toggle affordance does not flicker mid-stream.
  const clipped = resolveReasoningClipped(measurement, preview);
  const canToggle = preview !== null && clipped;
  const showDetails = expanded && canToggle;

  const onPreviewTextLayout = (event: NativeSyntheticEvent<TextLayoutEventData>) => {
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
          showDetails={showDetails}
          onPreviewTextLayout={onPreviewTextLayout}
          styles={styles}
        />
        <ReasoningCardDetails entry={entry} showDetails={showDetails} styles={styles} />
        {canToggle ? (
          <Text style={styles.reasoningToggleText}>
            {showDetails ? 'Tap to hide thinking' : 'Tap to show thinking'}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
