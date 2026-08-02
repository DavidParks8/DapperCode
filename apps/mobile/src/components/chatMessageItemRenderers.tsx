import { Ionicons } from '@expo/vector-icons';
import { useMemo, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import { Pressable, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { COMPACTION_ACTIVITY_TYPE, getSubAgentMeta, SUBAGENT_ACTIVITY_TYPE } from '../api/messages';
import { useAppTheme, type AppTheme } from '../theme';
import { ComputerUseTimeline } from './chatMessageComputerUse';
import { MessageActions } from './chatMessageActions';
import { SelectableTextSheet } from './chatMessageSelectTextSheet';
import { toTimelineDetailPreview, isViewedImageEntry } from './chatMessageContentHelpers';
import type { createMarkdownRules } from './chatMessageMarkdownRules';
import type { createMarkdownStyles } from './chatMessageMarkdownStyles';
import { MarkdownImage, SelectableMessageText } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import { ChatMessageUserBubble } from './chatMessageUserBubble';
import { ReasoningEntryCard } from './chatMessageReasoningCard';
import { SubAgentCard } from './SubAgentCard';
import {
  entriesAreComputerUseTimeline,
  formatCompactionLabel,
  isTerminalSubAgentStatus,
  toTimelineVisual,
} from './chatMessageTimelineHelpers';
import type { ChatMessageProps, MessageBlock, TimelineEntry } from './chatMessageTypes';
import { computeHitSlop } from './touchTarget';

type ChatMessageRecord = ChatMessageProps['message'];

// The chip's visible height is padding (theme.spacing.sm * 2) plus its icon/text row; its width
// varies with the URL label, so only the vertical axis is padded up to the platform minimum.
// Chips stack in a column with a 4px gap (localPreviewLinkList's `gap: theme.spacing.xs`), so
// vertical slop is capped at half that gap (2px) — otherwise one chip's bottom slop and the next
// chip's top slop would overlap and steal taps meant for the neighboring chip.
const LOCAL_PREVIEW_LINK_VISIBLE_SIZE = { width: 160, height: 32 };
const LOCAL_PREVIEW_LINK_HIT_SLOP_OPTIONS = { maxVertical: 2 };

function LocalPreviewLinks({
  messageId,
  urls,
  onOpen,
}: {
  messageId: string;
  urls: string[];
  onOpen?: (url: string) => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const hitSlop = useMemo(
    () => computeHitSlop(LOCAL_PREVIEW_LINK_VISIBLE_SIZE, LOCAL_PREVIEW_LINK_HIT_SLOP_OPTIONS),
    [],
  );
  if (!onOpen || urls.length === 0) {
    return null;
  }
  return (
    <View style={styles.localPreviewLinkList}>
      {urls.map((url) => (
        <Pressable
          key={`${messageId}-${url}`}
          onPress={() => onOpen(url)}
          style={({ pressed }) => [
            styles.localPreviewLink,
            pressed && styles.localPreviewLinkPressed,
          ]}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel={`Open ${url} in Browser`}
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="globe-outline"
            size={14}
            color={theme.colors.textPrimary}
          />
          <Text
            style={styles.localPreviewLinkText}
            numberOfLines={1}
          >{`Open ${url} in Browser`}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export interface ChatMessageRenderContext {
  message: ChatMessageRecord;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
  markdownStyles: ReturnType<typeof createMarkdownStyles>;
  markdownRules: ReturnType<typeof createMarkdownRules>;
  messageText: string;
  messageBlocks: MessageBlock[];
  localPreviewUrls: string[];
  copyText: string;
  selectTextVisible: boolean;
  openSelectText: () => void;
  closeSelectText: () => void;
  timelineEntries: TimelineEntry[] | null;
  expandedTimelineEntries: Record<string, boolean>;
  setExpandedTimelineEntries: Dispatch<SetStateAction<Record<string, boolean>>>;
  bridgeUrl: string | null;
  bridgeToken: string | null;
  onOpenLocalPreview?: (url: string) => void;
  onOpenSubAgentThread?: (threadId: string) => void;
}

type ChatMessageKind =
  'user' | 'assistantLike' | 'compaction' | 'reasoning' | 'subAgent' | 'timeline' | 'plainFallback';

export function classifyChatMessageKind(
  message: ChatMessageRecord,
  hasTimelineEntries: boolean,
): ChatMessageKind {
  if (message.role === 'user') {
    return 'user';
  }
  if (['assistant', 'developer', 'system'].includes(message.role)) {
    return 'assistantLike';
  }
  if (message.role === 'activity' && message.activityType === COMPACTION_ACTIVITY_TYPE) {
    return 'compaction';
  }
  if (message.role === 'reasoning') {
    return 'reasoning';
  }
  if (message.role === 'activity' && message.activityType === SUBAGENT_ACTIVITY_TYPE) {
    return 'subAgent';
  }
  if (hasTimelineEntries) {
    return 'timeline';
  }
  return 'plainFallback';
}

function renderUserChatMessage(ctx: ChatMessageRenderContext) {
  return <ChatMessageUserBubble messageId={ctx.message.id} blocks={ctx.messageBlocks} />;
}

function renderAssistantLikeChatMessage(ctx: ChatMessageRenderContext) {
  const { message, styles, theme, markdownStyles, markdownRules, messageBlocks } = ctx;
  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <Pressable
        testID={`chat-message-select-target-${message.id}`}
        onLongPress={ctx.copyText ? ctx.openSelectText : undefined}
        delayLongPress={400}
        style={styles.assistantContent}
        accessible={false}
      >
        {messageBlocks.map((block, index) => {
          if (block.kind === 'image') {
            return (
              <MarkdownImage
                key={`${message.id}-assistant-image-${String(index)}`}
                source={block.source}
                accessibilityLabel={block.accessibilityLabel}
              />
            );
          }
          if (block.kind === 'file') {
            return (
              <View
                key={`${message.id}-assistant-file-${String(index)}`}
                style={styles.userFileChip}
              >
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="document-text-outline"
                  size={12}
                  color={theme.colors.textMuted}
                />
                <Text style={styles.userFileChipText} numberOfLines={1}>
                  {block.value}
                </Text>
              </View>
            );
          }
          return (
            <Markdown
              key={`${message.id}-assistant-text-${String(index)}`}
              style={markdownStyles}
              rules={markdownRules}
            >
              {block.value || '\u258D'}
            </Markdown>
          );
        })}
      </Pressable>
      <LocalPreviewLinks
        messageId={message.id}
        urls={ctx.localPreviewUrls}
        onOpen={ctx.onOpenLocalPreview}
      />
      <MessageActions
        text={ctx.copyText}
        onSelectText={ctx.openSelectText}
        testID={`chat-message-copy-${message.id}`}
      />
      {ctx.selectTextVisible ? (
        <SelectableTextSheet
          text={ctx.copyText}
          onClose={ctx.closeSelectText}
          testID={`chat-message-select-text-${message.id}`}
        />
      ) : null}
    </View>
  );
}

function renderCompactionChatMessage(ctx: ChatMessageRenderContext) {
  const { styles, messageText } = ctx;
  return (
    <View
      style={[
        styles.messageWrapper,
        styles.messageWrapperAssistant,
        styles.messageWrapperFullWidth,
      ]}
    >
      <View style={styles.compactionRow}>
        <View style={styles.compactionLine} />
        <View style={styles.compactionBadge}>
          <Text style={styles.compactionText}>{formatCompactionLabel(messageText)}</Text>
        </View>
        <View style={styles.compactionLine} />
      </View>
    </View>
  );
}

function renderReasoningChatMessage(ctx: ChatMessageRenderContext) {
  const { message, styles, timelineEntries, messageText } = ctx;
  const entries = timelineEntries?.length
    ? timelineEntries
    : [{ title: 'Reasoning', details: [messageText] }];
  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <View style={styles.reasoningStack}>
        {entries.map((entry, index) => (
          <ReasoningEntryCard key={`${message.id}-reasoning-${String(index)}`} entry={entry} />
        ))}
      </View>
    </View>
  );
}

function renderSubAgentChatMessage(ctx: ChatMessageRenderContext) {
  const { message, styles, timelineEntries, messageText, onOpenSubAgentThread } = ctx;
  const entries = timelineEntries?.length ? timelineEntries : [{ title: messageText, details: [] }];
  const meta = getSubAgentMeta(message);
  const threadId = meta?.receiverThreadIds?.[0]?.trim() ?? '';
  const running = Boolean(meta?.agentStatus) && !isTerminalSubAgentStatus(meta?.agentStatus);
  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <SubAgentCard
        idPrefix={message.id}
        entries={entries}
        agentStatus={meta?.agentStatus}
        running={running}
        threadId={threadId}
        onOpen={onOpenSubAgentThread}
      />
    </View>
  );
}

function resolveTimelineToggleLabel(
  title: string,
  preview: ReturnType<typeof toTimelineDetailPreview>,
  expanded: boolean,
): string {
  if (preview.images.length && isViewedImageEntry(title, preview.textDetails)) {
    return expanded ? 'Tap to hide path' : 'Tap to show path';
  }
  if (expanded) {
    return 'Tap to hide details';
  }
  if (preview.textDetails.length <= 1) {
    return 'Tap to show details';
  }
  return `Tap to show ${String(preview.textDetails.length)} lines`;
}

function TimelineEntryCard({
  entry,
  index,
  messageId,
  theme,
  styles,
  bridgeUrl,
  bridgeToken,
  expandedTimelineEntries,
  setExpandedTimelineEntries,
}: {
  entry: TimelineEntry;
  index: number;
  messageId: string;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
  bridgeUrl: string | null;
  bridgeToken: string | null;
  expandedTimelineEntries: Record<string, boolean>;
  setExpandedTimelineEntries: Dispatch<SetStateAction<Record<string, boolean>>>;
}) {
  const visual = toTimelineVisual(entry.title);
  const preview = toTimelineDetailPreview(entry, bridgeUrl, bridgeToken);
  const entryKey = `${messageId}-timeline-${String(index)}`;
  const hasDetails = preview.textDetails.length > 0;
  const expanded = expandedTimelineEntries[entryKey] === true;
  const toggle = resolveTimelineToggleLabel(entry.title, preview, expanded);
  return (
    <Pressable
      disabled={!hasDetails}
      onPress={() =>
        hasDetails &&
        setExpandedTimelineEntries((previous) => ({ ...previous, [entryKey]: !previous[entryKey] }))
      }
      style={({ pressed }) => [
        styles.timelineCard,
        visual.isError && styles.timelineCardError,
        hasDetails && styles.timelineCardInteractive,
        pressed && hasDetails && styles.timelineCardPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={entry.title}
      accessibilityHint={hasDetails ? `${expanded ? 'Hides' : 'Shows'} tool details` : undefined}
      accessibilityState={controlAccessibilityState({
        disabled: !hasDetails,
        expanded: hasDetails ? expanded : undefined,
      })}
    >
      <View style={styles.timelineHeader}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={visual.icon}
          size={14}
          color={visual.isError ? theme.colors.statusError : theme.colors.statusRunning}
        />
        <Text
          style={[styles.timelineTitle, visual.useMonospaceTitle && styles.timelineTitleMono]}
          numberOfLines={expanded ? 3 : 1}
        >
          {entry.title}
        </Text>
        {hasDetails ? (
          <Ionicons
            {...decorativeAccessibilityProps}
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={theme.colors.textMuted}
          />
        ) : null}
      </View>
      {hasDetails ? <Text style={styles.timelineToggleText}>{toggle}</Text> : null}
      {preview.images.map((image, imageIndex) => (
        <MarkdownImage
          key={`${entryKey}-image-${String(imageIndex)}`}
          source={image.source}
          accessibilityLabel={image.accessibilityLabel}
        />
      ))}
      {expanded && hasDetails ? (
        <View style={styles.timelineDetailWrap}>
          {preview.textDetails.map((line, lineIndex) => (
            <SelectableMessageText
              key={`${entryKey}-line-${String(lineIndex)}`}
              style={styles.timelineDetailLine}
            >
              {line}
            </SelectableMessageText>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

function renderTimelineChatMessage(ctx: ChatMessageRenderContext) {
  const {
    message,
    styles,
    theme,
    timelineEntries,
    bridgeUrl,
    bridgeToken,
    expandedTimelineEntries,
    setExpandedTimelineEntries,
  } = ctx;
  const entries = timelineEntries ?? [];
  const toolEntries = entries.map((entry, index) => ({
    ...entry,
    id: `${message.id}-timeline-${String(index)}`,
  }));
  if (entriesAreComputerUseTimeline(toolEntries)) {
    return (
      <ComputerUseTimeline entries={toolEntries} bridgeUrl={bridgeUrl} bridgeToken={bridgeToken} />
    );
  }
  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <View style={styles.timelineCardStack}>
        {entries.map((entry, index) => (
          <TimelineEntryCard
            key={`${message.id}-timeline-${String(index)}`}
            entry={entry}
            index={index}
            messageId={message.id}
            theme={theme}
            styles={styles}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            expandedTimelineEntries={expandedTimelineEntries}
            setExpandedTimelineEntries={setExpandedTimelineEntries}
          />
        ))}
      </View>
    </View>
  );
}

function renderPlainFallbackChatMessage(ctx: ChatMessageRenderContext) {
  const { message, styles, markdownStyles, markdownRules, messageText } = ctx;
  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <Pressable
        testID={`chat-message-select-target-${message.id}`}
        onLongPress={ctx.copyText ? ctx.openSelectText : undefined}
        delayLongPress={400}
        accessible={false}
      >
        <Markdown style={markdownStyles} rules={markdownRules}>
          {messageText || '\u258D'}
        </Markdown>
      </Pressable>
      <LocalPreviewLinks
        messageId={message.id}
        urls={ctx.localPreviewUrls}
        onOpen={ctx.onOpenLocalPreview}
      />
      {ctx.selectTextVisible ? (
        <SelectableTextSheet
          text={ctx.copyText}
          onClose={ctx.closeSelectText}
          testID={`chat-message-select-text-${message.id}`}
        />
      ) : null}
    </View>
  );
}

export const CHAT_MESSAGE_RENDERERS: Record<
  ChatMessageKind,
  (ctx: ChatMessageRenderContext) => ReactElement
> = {
  user: renderUserChatMessage,
  assistantLike: renderAssistantLikeChatMessage,
  compaction: renderCompactionChatMessage,
  reasoning: renderReasoningChatMessage,
  subAgent: renderSubAgentChatMessage,
  timeline: renderTimelineChatMessage,
  plainFallback: renderPlainFallbackChatMessage,
};
