import { Ionicons } from '@expo/vector-icons';
import type { MutableRefObject, RefObject } from 'react';
import { ActivityIndicator, type FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Chat } from '../../api/types';
import { decorativeAccessibilityProps } from '../../accessibility';
import type { useAccessibilityFocus } from '../../accessibility';
import type { AppTheme } from '../../theme';
import type { AutoScrollState } from './mainScreenHelpers';
import type { buildAgentThreadDisplayState } from './agentThreadDisplay';
import type { TranscriptDisplayItem } from './transcriptMessages';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';
import { SubAgentTranscriptShimmer } from './SubAgentTranscriptShimmer';

export const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    page: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    header: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    iconButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerCopy: {
      flex: 1,
      minWidth: 0,
    },
    eyebrow: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    title: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    statusBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.colors.bgElevated,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    statusCopy: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    statusTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    statusLabel: {
      ...theme.typography.caption,
      fontWeight: '700',
    },
    activityDetail: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    errorText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
    },
    transcript: {
      flex: 1,
    },
    transcriptContent: {
      flex: 1,
    },
    loadingShell: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
    },
    loadingText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    startingHint: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textAlign: 'center',
      maxWidth: 260,
      paddingHorizontal: theme.spacing.lg,
    },
    startingHintLoading: {
      opacity: 0,
    },
  });

export interface SubAgentHeaderProps {
  title: string;
  navigateBack: () => void;
  headingFocusRef: ReturnType<typeof useAccessibilityFocus<Text>>;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}

export interface SubAgentStatusBarProps {
  display: ReturnType<typeof buildAgentThreadDisplayState> | null;
  loading: boolean;
  activityDetail: string | null;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}

export interface SubAgentTranscriptProps {
  chat: Chat | null;
  parentChat: Chat | null;
  bridgeUrl: string;
  bridgeToken: ChatTranscriptViewProps['bridgeToken'];
  openBrowser: ChatTranscriptViewProps['onOpenLocalPreview'];
  showToolCalls: boolean;
  onOpenSubAgentThread: (threadId: string) => void;
  agentThreadStatusById: ReadonlyMap<string, Chat['status']>;
  scrollRef: RefObject<FlatList<TranscriptDisplayItem> | null>;
  autoScrollStateRef: MutableRefObject<AutoScrollState>;
  liveMessageState: ChatTranscriptViewProps['liveMessageState'];
  projectedMessageCount: number;
  isStarting: boolean;
  isEmpty: boolean;
  isHydratingTranscript: boolean;
  showHydrationShimmer: boolean;
  detailLoading: boolean;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}

export function SubAgentHeader({
  title,
  navigateBack,
  headingFocusRef,
  styles,
  theme,
}: SubAgentHeaderProps) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={navigateBack}
        hitSlop={8}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel="Back from sub-agent transcript"
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="chevron-back"
          size={22}
          color={theme.colors.textPrimary}
        />
      </Pressable>
      <View style={styles.headerCopy}>
        <Text style={styles.eyebrow}>Sub-agent</Text>
        <Text
          ref={headingFocusRef}
          accessibilityRole="header"
          style={styles.title}
          numberOfLines={1}
        >
          {title}
        </Text>
      </View>
      <View style={styles.iconButton} />
    </View>
  );
}

export function SubAgentStatusBar({
  display,
  loading,
  activityDetail,
  styles,
  theme,
}: SubAgentStatusBarProps) {
  const statusColor = display?.statusColor ?? theme.colors.textMuted;
  const statusLabel = display?.label ?? (loading ? 'Loading' : 'Idle');

  return (
    <View style={styles.statusBar} accessibilityLiveRegion="polite">
      <View style={styles.statusCopy}>
        <View style={styles.statusTitleRow}>
          {display?.isActive ? (
            <ActivityIndicator size="small" color={statusColor} />
          ) : (
            <Ionicons
              {...decorativeAccessibilityProps}
              name={display?.icon ?? 'ellipse-outline'}
              size={15}
              color={statusColor}
            />
          )}
          <Text style={[styles.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
        </View>
        {activityDetail ? (
          <Text style={styles.activityDetail} numberOfLines={2}>
            {activityDetail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function SubAgentStartingState({
  detailLoading,
  styles,
  theme,
}: Pick<SubAgentTranscriptProps, 'detailLoading' | 'styles' | 'theme'>) {
  return (
    <View
      style={styles.loadingShell}
      accessibilityRole="progressbar"
      accessibilityLabel="Sub-agent starting"
    >
      <ActivityIndicator color={theme.colors.warning} />
      <Text style={styles.loadingText}>Starting…</Text>
      <Text
        style={[styles.startingHint, detailLoading && styles.startingHintLoading]}
        accessibilityElementsHidden={detailLoading}
        importantForAccessibility={detailLoading ? 'no-hide-descendants' : 'auto'}
      >
        This agent has not reported anything yet. Its work will stream in here.
      </Text>
    </View>
  );
}

export function SubAgentEmptyState({
  detailLoading,
  styles,
  theme,
}: Pick<SubAgentTranscriptProps, 'detailLoading' | 'styles' | 'theme'>) {
  return (
    <View style={styles.loadingShell} accessibilityLabel="Sub-agent reported no transcript">
      <Ionicons
        {...decorativeAccessibilityProps}
        name="document-text-outline"
        size={20}
        color={theme.colors.textMuted}
      />
      <Text style={styles.loadingText}>No transcript</Text>
      <Text
        style={[styles.startingHint, detailLoading && styles.startingHintLoading]}
        accessibilityElementsHidden={detailLoading}
        importantForAccessibility={detailLoading ? 'no-hide-descendants' : 'auto'}
      >
        This agent reported back through its parent instead of streaming its own session.
      </Text>
    </View>
  );
}

export function SubAgentLoadingState({
  styles,
  theme,
}: Pick<SubAgentTranscriptProps, 'styles' | 'theme'>) {
  return (
    <View
      style={styles.loadingShell}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading agent transcript"
    >
      <ActivityIndicator color={theme.colors.textMuted} />
      <Text style={styles.loadingText}>Loading agent transcript…</Text>
    </View>
  );
}

export function SubAgentTranscriptContent({
  chat,
  parentChat,
  bridgeUrl,
  bridgeToken,
  openBrowser,
  showToolCalls,
  onOpenSubAgentThread,
  agentThreadStatusById,
  scrollRef,
  autoScrollStateRef,
  liveMessageState,
  projectedMessageCount,
  isStarting,
  isEmpty,
  isHydratingTranscript,
  showHydrationShimmer,
  detailLoading,
  styles,
  theme,
}: SubAgentTranscriptProps) {
  const shouldRenderTranscript =
    Boolean(chat) && !isStarting && !isEmpty && projectedMessageCount > 0;
  const shouldRenderLoading =
    !isStarting && !isEmpty && !shouldRenderTranscript && !isHydratingTranscript;
  const transcriptChat = shouldRenderTranscript ? chat : null;

  return (
    <View style={styles.transcript}>
      <View
        style={styles.transcriptContent}
        accessibilityElementsHidden={showHydrationShimmer}
        importantForAccessibility={showHydrationShimmer ? 'no-hide-descendants' : 'auto'}
      >
        {isStarting ? (
          <SubAgentStartingState detailLoading={detailLoading} styles={styles} theme={theme} />
        ) : null}
        {isEmpty ? (
          <SubAgentEmptyState detailLoading={detailLoading} styles={styles} theme={theme} />
        ) : null}
        {transcriptChat ? (
          <ChatTranscriptView
            scrollRailEnabled={false}
            chat={transcriptChat}
            parentChat={parentChat}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            onOpenLocalPreview={openBrowser}
            showToolCalls={showToolCalls}
            onOpenSubAgentThread={onOpenSubAgentThread}
            agentThreadStatusById={agentThreadStatusById}
            scrollRef={scrollRef}
            inlineChoicesEnabled={false}
            onInlineOptionSelect={() => {}}
            onPinnedAutoScroll={() => {
              if (autoScrollStateRef.current.shouldStickToBottom) {
                scrollRef.current?.scrollToOffset({ offset: 0, animated: false });
              }
            }}
            onJumpToLatest={() => {
              scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
            }}
            onScrollInteractionStart={() => {}}
            autoScrollStateRef={autoScrollStateRef}
            bottomInset={0}
            liveMessageState={liveMessageState}
          />
        ) : null}
        {shouldRenderLoading ? <SubAgentLoadingState styles={styles} theme={theme} /> : null}
      </View>
      {showHydrationShimmer ? <SubAgentTranscriptShimmer /> : null}
    </View>
  );
}
