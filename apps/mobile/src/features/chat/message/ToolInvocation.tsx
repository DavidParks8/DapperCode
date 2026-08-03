import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAtom } from 'jotai';
import { memo, useCallback, useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { expandedToolInvocationIdsAtom } from '../state/toolInvocations';
import { useAppTheme } from '@shared/theme';
import { motionDuration } from '@shared/ui/motion';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { createStyles } from './styles';
import { ToolHeaderShimmer } from './ToolHeaderShimmer';
import { createToolCardStyles } from './toolCardStyles';
import { ToolInvocationOutput } from './ToolOutput';
import { toolKindIcon, type ToolInvocation } from './toolInvocationModel';
import {
  resolveToolInvocationHeader,
  type ToolInvocationHeader,
} from './toolInvocationPresentation';
import { horizontalFadeColors, useHorizontalOverflow } from './useHorizontalOverflow';
import type { ChatToolStatus } from '@bridge/types/types';

const TOOL_ROW_VISIBLE_SIZE = { width: 200, height: 26 };

function ToolHeaderText({
  invocation,
  header,
  expandable,
  running,
  toggle,
}: {
  invocation: ToolInvocation;
  header: ToolInvocationHeader;
  expandable: boolean;
  running: boolean;
  toggle: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createToolCardStyles(theme), [theme]);
  const textStyles = [styles.rowSubject, invocation.isError && styles.rowTitleError];
  const commandOverflow = useHorizontalOverflow();
  const renderCommand = (highlight: boolean) => (
    <>
      {header.action ? (
        <Animated.Text
          style={[
            styles.rowAction,
            invocation.isError && styles.rowTitleError,
            highlight && styles.rowTextHighlight,
          ]}
        >
          {header.action}
        </Animated.Text>
      ) : null}
      <Animated.Text
        style={[textStyles, styles.rowSubjectMono, highlight && styles.rowTextHighlight]}
        numberOfLines={1}
      >
        {header.subject}
      </Animated.Text>
    </>
  );

  if (invocation.monospaceTitle && header.subject) {
    return (
      <View style={styles.horizontalScrollFrame}>
        <ScrollView
          horizontal
          bounces={false}
          nestedScrollEnabled
          directionalLockEnabled
          style={styles.commandScroll}
          contentContainerStyle={styles.commandScrollContent}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onLayout={commandOverflow.onLayout}
          onContentSizeChange={commandOverflow.onContentSizeChange}
          onScroll={commandOverflow.onScroll}
          scrollEventThrottle={16}
          testID="tool-command-scroll"
          accessible={false}
        >
          <Pressable
            disabled={!expandable}
            onPress={toggle}
            accessible={false}
            accessibilityLabel={invocation.title}
            style={({ pressed }) => [
              styles.commandPressable,
              pressed && expandable && styles.rowPressed,
            ]}
            testID="tool-command-toggle"
          >
            {renderCommand(false)}
            <ToolHeaderShimmer active={running} contentStyle={styles.commandPressable}>
              {renderCommand(true)}
            </ToolHeaderShimmer>
          </Pressable>
        </ScrollView>
        {commandOverflow.showEndFade ? (
          <LinearGradient
            colors={horizontalFadeColors(theme.colors.bgMain)}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            pointerEvents="none"
            style={styles.horizontalOverflowFade}
            testID="tool-command-overflow-fade"
          />
        ) : null}
      </View>
    );
  }

  return (
    <Pressable
      disabled={!expandable}
      onPress={toggle}
      accessible={false}
      accessibilityLabel={invocation.title}
      style={({ pressed }) => [
        styles.rowContentPressable,
        pressed && expandable && styles.rowPressed,
      ]}
      testID="tool-title-toggle"
    >
      <Animated.Text style={textStyles} numberOfLines={1}>
        {header.label}
      </Animated.Text>
      <ToolHeaderShimmer active={running} contentStyle={styles.rowContentPressable}>
        <Animated.Text style={[textStyles, styles.rowTextHighlight]} numberOfLines={1}>
          {header.label}
        </Animated.Text>
      </ToolHeaderShimmer>
    </Pressable>
  );
}

function ToolTrailing({
  status,
  expanded,
  expandable,
  toggle,
}: {
  status: ChatToolStatus;
  expanded: boolean;
  expandable: boolean;
  toggle: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createToolCardStyles(theme), [theme]);
  return (
    <Pressable
      disabled={!expandable}
      onPress={toggle}
      accessible={false}
      style={({ pressed }) => [
        styles.rowRegion,
        styles.rowTrailing,
        pressed && expandable && styles.rowPressed,
      ]}
      testID="tool-trailing-toggle"
    >
      {status === 'failed' ? (
        <Ionicons
          {...decorativeAccessibilityProps}
          name="close-circle"
          size={13}
          color={theme.colors.statusError}
        />
      ) : status === 'pending' ? (
        <Ionicons
          {...decorativeAccessibilityProps}
          name="ellipsis-horizontal"
          size={13}
          color={theme.colors.textMuted}
        />
      ) : null}
      {expandable ? (
        <Ionicons
          {...decorativeAccessibilityProps}
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={13}
          color={theme.colors.textMuted}
        />
      ) : null}
    </Pressable>
  );
}

export const ToolInvocationRow = memo(function ToolInvocationRowComponent({
  invocation,
  bridgeUrl = null,
  bridgeToken = null,
  threadRunning = true,
}: {
  invocation: ToolInvocation;
  bridgeUrl?: string | null;
  bridgeToken?: string | null;
  threadRunning?: boolean;
}) {
  const theme = useAppTheme();
  const messageStyles = useMemo(() => createStyles(theme), [theme]);
  const styles = useMemo(() => createToolCardStyles(theme), [theme]);
  const [expandedIds, setExpandedIds] = useAtom(expandedToolInvocationIdsAtom);
  const expanded = expandedIds[invocation.id] === true;
  const expandable = !invocation.empty || invocation.truncated;
  const header = useMemo(
    () => resolveToolInvocationHeader(invocation, threadRunning),
    [invocation, threadRunning],
  );
  const toggle = useCallback(() => {
    if (expandable) {
      setExpandedIds((previous) => ({ ...previous, [invocation.id]: !previous[invocation.id] }));
    }
  }, [expandable, invocation.id, setExpandedIds]);
  const running = threadRunning && invocation.status === 'in_progress' && !invocation.isError;

  return (
    <Animated.View
      style={[messageStyles.messageWrapper, messageStyles.messageWrapperAssistant]}
      layout={LinearTransition.duration(motionDuration.layout).reduceMotion(ReduceMotion.System)}
    >
      <View
        style={[styles.row, invocation.isError && styles.rowError]}
        accessible
        accessibilityRole="button"
        accessibilityLabel={header.label}
        accessibilityHint={expandable ? `${expanded ? 'Hides' : 'Shows'} tool results` : undefined}
        accessibilityState={controlAccessibilityState({
          disabled: !expandable,
          expanded: expandable ? expanded : undefined,
        })}
        accessibilityValue={{ text: header.status.replace('_', ' ') }}
        accessibilityActions={
          expandable ? [{ name: 'activate', label: 'Toggle tool results' }] : []
        }
        onAccessibilityTap={toggle}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'activate') {
            toggle();
          }
        }}
        testID="tool-row"
      >
        <Pressable
          disabled={!expandable}
          onPress={toggle}
          accessible={false}
          hitSlop={computeHitSlop(TOOL_ROW_VISIBLE_SIZE, { maxHorizontal: 0 })}
          style={({ pressed }) => [
            styles.rowTouchTarget,
            pressed && expandable && styles.rowPressed,
          ]}
          testID="tool-row-toggle"
        />
        <Pressable
          disabled={!expandable}
          onPress={toggle}
          accessible={false}
          style={({ pressed }) => [
            styles.rowRegion,
            styles.rowIcon,
            pressed && expandable && styles.rowPressed,
          ]}
          testID="tool-icon-toggle"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name={invocation.isError ? 'alert-circle-outline' : toolKindIcon(invocation.kind)}
            size={14}
            color={invocation.isError ? theme.colors.statusError : theme.colors.textMuted}
          />
        </Pressable>
        <View style={styles.rowContent}>
          <ToolHeaderText
            invocation={invocation}
            header={header}
            expandable={expandable}
            running={running}
            toggle={toggle}
          />
        </View>
        <ToolTrailing
          status={header.status}
          expanded={expanded}
          expandable={expandable}
          toggle={toggle}
        />
      </View>
      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
        >
          <ToolInvocationOutput
            invocation={invocation}
            headerLabel={header.label}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
});

ToolInvocationRow.displayName = 'ToolInvocationRow';
