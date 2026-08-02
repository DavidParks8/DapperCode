import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import {
  COMPACTION_ACTIVITY_TYPE,
  getMessageText,
  getSubAgentMeta,
  SUBAGENT_ACTIVITY_TYPE,
} from '../api/messages';
import { extractLocalPreviewUrls } from '../browserPreview';
import type { ChatMessagePart } from '../api/types';
import { useAppTheme } from '../theme';
import { ComputerUseTimeline } from './chatMessageComputerUse';
import { MessageActions } from './chatMessageActions';
import { SelectableTextSheet } from './chatMessageSelectTextSheet';
import {
  messagePartToBlocks,
  parseMessageBlocks,
  toTimelineDetailPreview,
  isViewedImageEntry,
} from './chatMessageContentHelpers';
import { createMarkdownRules } from './chatMessageMarkdownRules';
import { createMarkdownStyles } from './chatMessageMarkdownStyles';
import { MarkdownImage, SelectableMessageText } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import { ChatMessageUserBubble } from './chatMessageUserBubble';
import { ReasoningEntryCard } from './chatMessageReasoningCard';
import { SubAgentCard } from './SubAgentCard';
import {
  entriesAreComputerUseTimeline,
  formatCompactionLabel,
  isTerminalSubAgentStatus,
  parseTimelineEntries,
  toTimelineVisual,
} from './chatMessageTimelineHelpers';
import type { ChatMessageProps } from './chatMessageTypes';
import { computeHitSlop } from './touchTarget';

// The chip's visible height is padding (theme.spacing.sm * 2) plus its icon/text row; its width
// varies with the URL label, so only the vertical axis is padded up to the platform minimum.
const LOCAL_PREVIEW_LINK_VISIBLE_SIZE = { width: 160, height: 32 };

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
  const hitSlop = useMemo(() => computeHitSlop(LOCAL_PREVIEW_LINK_VISIBLE_SIZE), []);
  if (!onOpen || urls.length === 0) return null;
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

function ChatMessageComponent({
  message,
  bridgeUrl = null,
  bridgeToken = null,
  onOpenLocalPreview,
  onOpenSubAgentThread,
}: ChatMessageProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
  const markdownRules = useMemo(
    // The chat surface offers its own selection sheet, so the markdown must not claim the long
    // press for React Native's copy-the-whole-block edit menu.
    () => createMarkdownRules(bridgeUrl, bridgeToken, onOpenLocalPreview, { selectable: false }),
    [bridgeToken, bridgeUrl, onOpenLocalPreview],
  );
  const [expandedTimelineEntries, setExpandedTimelineEntries] = useState<Record<string, boolean>>(
    {},
  );
  const [selectTextVisible, setSelectTextVisible] = useState(false);
  const openSelectText = useCallback(() => {
    setSelectTextVisible(true);
  }, []);
  const closeSelectText = useCallback(() => {
    setSelectTextVisible(false);
  }, []);
  const messageText = getMessageText(message);
  const messageBlocks = useMemo(
    () =>
      message.parts?.length
        ? message.parts.flatMap((part) => messagePartToBlocks(part, bridgeUrl, bridgeToken))
        : parseMessageBlocks(messageText, bridgeUrl, bridgeToken),
    [bridgeToken, bridgeUrl, message.parts, messageText],
  );
  const localPreviewUrls = useMemo(
    () =>
      ['assistant', 'system', 'developer'].includes(message.role)
        ? extractLocalPreviewUrls(messageText)
        : [],
    [message.role, messageText],
  );
  const copyText = useMemo(
    () =>
      messageBlocks
        .flatMap((block) => (block.kind === 'text' ? [block.value] : []))
        .join('\n\n')
        .trim() || messageText.trim(),
    [messageBlocks, messageText],
  );

  if (message.role === 'user')
    return <ChatMessageUserBubble messageId={message.id} blocks={messageBlocks} />;

  if (['assistant', 'developer', 'system'].includes(message.role))
    return (
      <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
        <Pressable
          testID={`chat-message-select-target-${message.id}`}
          onLongPress={copyText ? openSelectText : undefined}
          delayLongPress={400}
          style={styles.assistantContent}
          accessible={false}
        >
          {messageBlocks.map((block, index) => {
            if (block.kind === 'image')
              return (
                <MarkdownImage
                  key={`${message.id}-assistant-image-${String(index)}`}
                  source={block.source}
                  accessibilityLabel={block.accessibilityLabel}
                />
              );
            if (block.kind === 'file')
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
          urls={localPreviewUrls}
          onOpen={onOpenLocalPreview}
        />
        <MessageActions
          text={copyText}
          onSelectText={openSelectText}
          testID={`chat-message-copy-${message.id}`}
        />
        {selectTextVisible ? (
          <SelectableTextSheet
            text={copyText}
            onClose={closeSelectText}
            testID={`chat-message-select-text-${message.id}`}
          />
        ) : null}
      </View>
    );

  const timelineEntries = ['tool', 'reasoning', 'activity'].includes(message.role)
    ? parseTimelineEntries(messageText)
    : null;
  if (message.role === 'activity' && message.activityType === COMPACTION_ACTIVITY_TYPE)
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

  if (message.role === 'reasoning') {
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

  if (message.role === 'activity' && message.activityType === SUBAGENT_ACTIVITY_TYPE) {
    const entries = timelineEntries?.length
      ? timelineEntries
      : [{ title: messageText, details: [] }];
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

  if (timelineEntries?.length) {
    const toolEntries = timelineEntries.map((entry, index) => ({
      ...entry,
      id: `${message.id}-timeline-${String(index)}`,
    }));
    if (entriesAreComputerUseTimeline(toolEntries))
      return (
        <ComputerUseTimeline
          entries={toolEntries}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
        />
      );
    return (
      <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
        <View style={styles.timelineCardStack}>
          {timelineEntries.map((entry, index) => {
            const visual = toTimelineVisual(entry.title);
            const preview = toTimelineDetailPreview(entry, bridgeUrl, bridgeToken);
            const key = `${message.id}-timeline-${String(index)}`;
            const hasDetails = preview.textDetails.length > 0;
            const expanded = expandedTimelineEntries[key] === true;
            const toggle =
              preview.images.length && isViewedImageEntry(entry.title, preview.textDetails)
                ? expanded
                  ? 'Tap to hide path'
                  : 'Tap to show path'
                : expanded
                  ? 'Tap to hide details'
                  : preview.textDetails.length <= 1
                    ? 'Tap to show details'
                    : `Tap to show ${String(preview.textDetails.length)} lines`;
            return (
              <Pressable
                key={key}
                disabled={!hasDetails}
                onPress={() =>
                  hasDetails &&
                  setExpandedTimelineEntries((previous) => ({ ...previous, [key]: !previous[key] }))
                }
                style={({ pressed }) => [
                  styles.timelineCard,
                  visual.isError && styles.timelineCardError,
                  hasDetails && styles.timelineCardInteractive,
                  pressed && hasDetails && styles.timelineCardPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={entry.title}
                accessibilityHint={
                  hasDetails ? `${expanded ? 'Hides' : 'Shows'} tool details` : undefined
                }
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
                    style={[
                      styles.timelineTitle,
                      visual.useMonospaceTitle && styles.timelineTitleMono,
                    ]}
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
                    key={`${key}-image-${String(imageIndex)}`}
                    source={image.source}
                    accessibilityLabel={image.accessibilityLabel}
                  />
                ))}
                {expanded && hasDetails ? (
                  <View style={styles.timelineDetailWrap}>
                    {preview.textDetails.map((line, lineIndex) => (
                      <SelectableMessageText
                        key={`${key}-line-${String(lineIndex)}`}
                        style={styles.timelineDetailLine}
                      >
                        {line}
                      </SelectableMessageText>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.messageWrapper, styles.messageWrapperAssistant]}>
      <Pressable
        testID={`chat-message-select-target-${message.id}`}
        onLongPress={copyText ? openSelectText : undefined}
        delayLongPress={400}
        accessible={false}
      >
        <Markdown style={markdownStyles} rules={markdownRules}>
          {messageText || '\u258D'}
        </Markdown>
      </Pressable>
      <LocalPreviewLinks
        messageId={message.id}
        urls={localPreviewUrls}
        onOpen={onOpenLocalPreview}
      />
      {selectTextVisible ? (
        <SelectableTextSheet
          text={copyText}
          onClose={closeSelectText}
          testID={`chat-message-select-text-${message.id}`}
        />
      ) : null}
    </View>
  );
}

/**
 * Shallow field-by-field equality for a single message part, one level deep into the nested
 * `resource` object for `{ type: 'resource' }` parts. Avoids `JSON.stringify`-based comparison,
 * which reallocates and serializes the whole structure on every render — expensive on the hot
 * path where `ChatMessage` re-renders on each streamed token.
 */
function arePartsEqual(previous?: ChatMessagePart[], next?: ChatMessagePart[]): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (!isPartEqual(previous[index], next[index])) return false;
  }
  return true;
}

function isPartEqual(previous: ChatMessagePart, next: ChatMessagePart): boolean {
  if (previous === next) return true;
  if (previous.type !== next.type) return false;
  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  const nextKeys = Object.keys(nextRecord);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of previousKeys) {
    const previousValue = previousRecord[key];
    const nextValue = nextRecord[key];
    if (previousValue === nextValue) continue;
    // `{ type: 'resource' }` parts nest an inner plain object; compare it shallowly too rather
    // than treating any object-valued field as an automatic mismatch.
    if (
      key === 'resource' &&
      previousValue &&
      nextValue &&
      typeof previousValue === 'object' &&
      typeof nextValue === 'object'
    ) {
      if (
        isShallowRecordEqual(
          previousValue as Record<string, unknown>,
          nextValue as Record<string, unknown>,
        )
      ) {
        continue;
      }
    }
    return false;
  }
  return true;
}

function isShallowRecordEqual(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every((key) => previous[key] === next[key]);
}

/** Exported for direct unit testing of the memo comparator's field-aware equality. */
export function areChatMessagePropsEqual(
  previousProps: ChatMessageProps,
  nextProps: ChatMessageProps,
): boolean {
  const previous = previousProps.message;
  const next = nextProps.message;
  if (previous === next) return true;
  return (
    previous.id === next.id &&
    previous.role === next.role &&
    previous.content === next.content &&
    previous.createdAt === next.createdAt &&
    // Ordered parts take priority over `content` when rendering, so a parts-only
    // change still has to repaint the bubble.
    arePartsEqual(previous.parts, next.parts) &&
    (previous.role !== 'activity' ||
      next.role !== 'activity' ||
      previous.activityType === next.activityType) &&
    previousProps.bridgeUrl === nextProps.bridgeUrl &&
    previousProps.bridgeToken === nextProps.bridgeToken &&
    previousProps.onOpenLocalPreview === nextProps.onOpenLocalPreview &&
    previousProps.onOpenSubAgentThread === nextProps.onOpenSubAgentThread
  );
}


export const ChatMessage = memo(ChatMessageComponent, areChatMessagePropsEqual);
ChatMessage.displayName = 'ChatMessage';
