import { Ionicons } from '@expo/vector-icons';
import { useAtom } from 'jotai';
import { memo, useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { expandedToolInvocationIdsAtom } from '../state/mainScreen/toolInvocations';
import { useAppTheme } from '../theme';
import { ScrollableRowText } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import { ToolInvocationOutput } from './chatMessageToolOutput';
import { toolKindIcon, type ToolInvocation } from './toolInvocationModel';

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
  const toggle = useCallback(() => {
    setExpandedIds((previous) => ({ ...previous, [invocation.id]: !previous[invocation.id] }));
  }, [invocation.id, setExpandedIds]);

  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <Pressable
        disabled={!expandable}
        onPress={toggle}
        style={({ pressed }) => [
          styles.toolRow,
          invocation.isError && styles.toolRowError,
          pressed && expandable && styles.toolRowPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={invocation.title}
        accessibilityHint={
          expandable ? `${expanded ? 'Hides' : 'Shows'} tool output` : undefined
        }
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
        {invocation.monospaceTitle && !expanded ? (
          <ScrollableRowText
            style={[
              styles.toolRowTitle,
              styles.toolRowTitleMono,
              invocation.isError && styles.toolRowTitleError,
            ]}
            backgroundColor={theme.colors.bgMain}
            testID="tool-command-scroll"
          >
            {invocation.title}
          </ScrollableRowText>
        ) : (
          <Text
            style={[
              styles.toolRowTitle,
              invocation.monospaceTitle && styles.toolRowTitleMono,
              invocation.isError && styles.toolRowTitleError,
            ]}
            numberOfLines={expanded ? 3 : 1}
          >
            {invocation.title}
          </Text>
        )}
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
        <ToolInvocationOutput
          invocation={invocation}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
        />
      ) : null}
    </View>
  );
});
ToolInvocationRow.displayName = 'ToolInvocationRow';

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
