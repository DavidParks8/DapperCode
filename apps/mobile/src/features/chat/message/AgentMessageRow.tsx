import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { motion, useAppTheme, type AppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import type { ChatAgentMessageMeta } from '@bridge/types/types';
import { createStyles } from './styles';
import { createToolCardStyles } from './toolCardStyles';

const AGENT_MESSAGE_ROW_VISIBLE_SIZE = { width: 200, height: 26 };

export function agentMessageRelationLabel(relation: ChatAgentMessageMeta['relation']): string {
  return relation === 'parent' ? 'parent' : 'sub-agent';
}

export function agentMessageHeaderLabel(meta: ChatAgentMessageMeta): string {
  const verb = meta.direction === 'sent' ? 'Sent to' : 'Received from';
  return `${verb} ${agentMessageRelationLabel(meta.relation)}`;
}

const createAgentMessageStyles = (theme: AppTheme) =>
  StyleSheet.create({
    headerText: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingLeft: theme.spacing.sm,
    },
    headerVerb: {
      ...theme.typography.caption,
      color: theme.colors.textPrimary,
      lineHeight: 16,
      flexShrink: 0,
    },
    headerSubject: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      lineHeight: 16,
      flexShrink: 1,
    },
    disposition: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      textTransform: 'capitalize',
    },
    body: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
    },
    metadata: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
    },
  });

export const AgentMessageRow = memo(function AgentMessageRowComponent({
  messageId,
  meta,
}: {
  messageId: string;
  meta: ChatAgentMessageMeta;
}) {
  const theme = useAppTheme();
  const messageStyles = useMemo(() => createStyles(theme), [theme]);
  const toolStyles = useMemo(() => createToolCardStyles(theme), [theme]);
  const styles = useMemo(() => createAgentMessageStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const headerLabel = agentMessageHeaderLabel(meta);
  const relatedLabel = meta.relatedTitle?.trim() || meta.relatedThreadId;
  const accessibilityValue =
    meta.direction === 'sent' ? `${relatedLabel}, ${meta.disposition}` : relatedLabel;

  return (
    <Animated.View
      style={[
        messageStyles.messageWrapper,
        messageStyles.messageWrapperAssistant,
        toolStyles.rowLayoutClip,
      ]}
      layout={LinearTransition.duration(motion.duration.layout).reduceMotion(ReduceMotion.System)}
      testID={`agent-message-row-${messageId}`}
    >
      <Pressable
        style={({ pressed }) => [toolStyles.row, pressed && toolStyles.rowPressed]}
        onPress={toggle}
        hitSlop={computeHitSlop(AGENT_MESSAGE_ROW_VISIBLE_SIZE, { maxHorizontal: 0 })}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${headerLabel}: ${relatedLabel}`}
        accessibilityHint={`${expanded ? 'Hides' : 'Shows'} the agent message`}
        accessibilityState={controlAccessibilityState({ expanded })}
        accessibilityValue={{ text: accessibilityValue }}
        accessibilityActions={[{ name: 'activate', label: 'Toggle agent message' }]}
        onAccessibilityTap={toggle}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'activate') {
            toggle();
          }
        }}
        testID={`agent-message-toggle-${messageId}`}
      >
        <View style={[toolStyles.rowRegion, toolStyles.rowIcon]}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={
              meta.direction === 'sent' ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline'
            }
            size={14}
            color={theme.colors.textMuted}
          />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.headerVerb} numberOfLines={1}>
            {headerLabel}
          </Text>
          <Text style={styles.headerSubject} numberOfLines={1}>
            {relatedLabel}
          </Text>
        </View>
        <View style={[toolStyles.rowRegion, toolStyles.rowTrailing]}>
          {meta.direction === 'sent' ? (
            <Text style={styles.disposition}>{meta.disposition}</Text>
          ) : null}
          <Ionicons
            {...decorativeAccessibilityProps}
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={13}
            color={theme.colors.textMuted}
          />
        </View>
      </Pressable>
      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(motion.duration.routine).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.duration.routine).reduceMotion(ReduceMotion.System)}
          style={toolStyles.panel}
        >
          <ScrollView
            nestedScrollEnabled
            style={toolStyles.panelScroll}
            contentContainerStyle={toolStyles.panelSection}
            showsVerticalScrollIndicator
          >
            <Text style={styles.body} selectable>
              {meta.body}
            </Text>
            <Text style={styles.metadata} selectable>
              {`${agentMessageRelationLabel(meta.relation)} · ${relatedLabel} · ${meta.relatedThreadId}`}
            </Text>
          </ScrollView>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
});

AgentMessageRow.displayName = 'AgentMessageRow';
