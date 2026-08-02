import { Ionicons } from '@expo/vector-icons';
import { useAtom } from 'jotai';
import { memo, useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { expandedToolInvocationIdsAtom } from '../state/mainScreen/toolInvocations';
import { useAppTheme } from '../theme';
import { motionDuration } from './motion';
import { computeHitSlop } from './touchTarget';
import { ScrollableRowText } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import { ToolInvocationOutput } from './chatMessageToolOutput';
import { toolKindIcon, type ToolInvocation } from './toolInvocationModel';

// The collapsed row is a dense single line (~26pt); pad it toward the 44pt/48dp minimum without
// growing its visible chrome.
const TOOL_ROW_VISIBLE_SIZE = { width: 200, height: 26 };

function ToolInvocationTitle({
  invocation,
  expanded,
  collapsedTitle,
  theme,
  styles,
}: {
  invocation: ToolInvocation;
  expanded: boolean;
  collapsedTitle: string;
  theme: ReturnType<typeof useAppTheme>;
  styles: ReturnType<typeof createStyles>;
}) {
  if (invocation.monospaceTitle && !expanded) {
    return (
      <ScrollableRowText
        style={[
          styles.toolRowTitle,
          styles.toolRowTitleMono,
          invocation.isError && styles.toolRowTitleError,
        ]}
        backgroundColor={theme.colors.bgMain}
        numberOfLines={1}
        testID="tool-command-scroll"
      >
        {collapsedTitle}
      </ScrollableRowText>
    );
  }
  return (
    <Text
      style={[
        styles.toolRowTitle,
        invocation.monospaceTitle && styles.toolRowTitleMono,
        invocation.isError && styles.toolRowTitleError,
      ]}
      numberOfLines={expanded ? 3 : 1}
    >
      {expanded ? invocation.title : collapsedTitle}
    </Text>
  );
}

export const ToolInvocationRow = memo(function ToolInvocationRowComponent({
  invocation,
  bridgeUrl = null,
  bridgeToken = null,
}: {
  invocation: ToolInvocation;
  bridgeUrl?: string | null;
  bridgeToken?: string | null;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expandedIds, setExpandedIds] = useAtom(expandedToolInvocationIdsAtom);
  const expanded = expandedIds[invocation.id] === true;
  const expandable = !invocation.empty || invocation.truncated;
  const collapsedTitle = useMemo(() => toSingleLine(invocation.title), [invocation.title]);
  const toggle = useCallback(() => {
    setExpandedIds((previous) => ({ ...previous, [invocation.id]: !previous[invocation.id] }));
  }, [invocation.id, setExpandedIds]);
  const toggleHitSlop = useMemo(() => computeHitSlop(TOOL_ROW_VISIBLE_SIZE), []);

  return (
    <Animated.View
      style={[styles.messageWrapper, styles.messageWrapperAssistant]}
      layout={LinearTransition.duration(motionDuration.layout).reduceMotion(ReduceMotion.System)}
    >
      <Pressable
        disabled={!expandable}
        onPress={toggle}
        hitSlop={toggleHitSlop}
        style={({ pressed }) => [
          styles.toolRow,
          invocation.isError && styles.toolRowError,
          pressed && expandable && styles.toolRowPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={invocation.title}
        accessibilityHint={expandable ? `${expanded ? 'Hides' : 'Shows'} tool output` : undefined}
        accessibilityState={controlAccessibilityState({
          disabled: !expandable,
          expanded: expandable ? expanded : undefined,
        })}
      >
        <View style={styles.toolRowIcon}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={invocation.isError ? 'alert-circle-outline' : toolKindIcon(invocation.kind)}
            size={14}
            color={invocation.isError ? theme.colors.statusError : theme.colors.textMuted}
          />
        </View>
        <ToolInvocationTitle
          invocation={invocation}
          expanded={expanded}
          collapsedTitle={collapsedTitle}
          theme={theme}
          styles={styles}
        />
        <View style={styles.toolRowTrailing}>
          <ToolStatusAffordance invocation={invocation} />
          {expandable ? (
            <Ionicons
              {...decorativeAccessibilityProps}
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={13}
              color={theme.colors.textMuted}
            />
          ) : null}
        </View>
      </Pressable>
      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
        >
          <ToolInvocationOutput
            invocation={invocation}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
});

ToolInvocationRow.displayName = 'ToolInvocationRow';

/**
 * A collapsed row is one line tall, so a title that spans several lines — a
 * chained or heredoc shell command, mostly — is flattened. `numberOfLines`
 * alone would hide everything after the first line even while scrolling.
 */
function toSingleLine(title: string): string {
  return title.replace(/\s*\r?\n\s*/g, ' ').trim();
}

function ToolStatusAffordance({ invocation }: { invocation: ToolInvocation }) {
  const theme = useAppTheme();
  if (invocation.status === 'in_progress') {
    return (
      <ActivityIndicator
        size="small"
        color={theme.colors.statusRunning}
        accessibilityLabel="Running"
      />
    );
  }
  if (invocation.status === 'failed') {
    return (
      <Ionicons
        {...decorativeAccessibilityProps}
        name="close-circle"
        size={13}
        color={theme.colors.statusError}
      />
    );
  }
  if (invocation.status === 'pending') {
    return (
      <Ionicons
        {...decorativeAccessibilityProps}
        name="ellipsis-horizontal"
        size={13}
        color={theme.colors.textMuted}
      />
    );
  }
  return null;
}
