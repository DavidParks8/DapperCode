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

export function ReasoningEntryCard({
  entry,
  pending,
}: {
  entry: TimelineEntry;
  pending: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const [measurement, setMeasurement] = useState<PreviewMeasurement | null>(null);

  const preview = entry.details.length > 0 ? summarizeReasoningPreview(entry.details) : null;
  // While a changed preview is re-measured, keep the previous result so the
  // toggle affordance does not flicker mid-stream.
  const clipped =
    measurement !== null && measurement.text === preview
      ? measurement.clipped
      : (measurement?.clipped ?? false);
  const canToggle = preview !== null && (!pending || clipped);
  const showDetails = expanded && canToggle;

  const onPreviewTextLayout = (event: NativeSyntheticEvent<TextLayoutEventData>) => {
    if (preview === null) return;
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
        <View style={styles.reasoningHeader}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="sparkles-outline"
            size={13}
            color={theme.colors.textMuted}
          />
          <Text style={styles.reasoningTitle}>{entry.title}</Text>
          {canToggle ? (
            <Ionicons
              {...decorativeAccessibilityProps}
              name={showDetails ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={theme.colors.textMuted}
            />
          ) : null}
        </View>
        {pending && !showDetails && preview ? (
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
        ) : null}
        {showDetails ? (
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
        ) : null}
        {pending && canToggle ? (
          <Text style={styles.reasoningToggleText}>
            {showDetails ? 'Tap to hide thinking' : 'Tap to show thinking'}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
