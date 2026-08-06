import { memo, useCallback, useMemo, useState } from 'react';

import { getMessageText } from '@bridge/messages';
import { extractLocalPreviewUrls } from '../../browser/preview';
import type { ChatMessagePart } from '@bridge/types/types';
import { useAppTheme } from '@shared/theme';
import { messagePartToBlocks, parseMessageBlocks } from './contentHelpers';
import { createMarkdownRules } from './markdownRules';
import { createMarkdownStyles } from './markdownStyles';
import { createStyles } from './styles';
import { parseTimelineEntries } from './timelineHelpers';
import type { ChatMessageProps } from './types';
import {
  CHAT_MESSAGE_RENDERERS,
  classifyChatMessageKind,
  type ChatMessageRenderContext,
} from './itemRenderers';

function ChatMessageComponent({
  message,
  bridgeUrl = null,
  bridgeToken = null,
  onOpenLocalPreview,
  onOpenSubAgentThread,
  onForkConversation,
  forkBusy = false,
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

  const timelineEntries = ['tool', 'reasoning', 'activity'].includes(message.role)
    ? parseTimelineEntries(messageText)
    : null;

  const ctx: ChatMessageRenderContext = {
    message,
    theme,
    styles,
    markdownStyles,
    markdownRules,
    messageText,
    messageBlocks,
    localPreviewUrls,
    copyText,
    selectTextVisible,
    openSelectText,
    closeSelectText,
    timelineEntries,
    expandedTimelineEntries,
    setExpandedTimelineEntries,
    bridgeUrl,
    bridgeToken,
    onOpenLocalPreview,
    onOpenSubAgentThread,
    onForkConversation,
    forkBusy,
  };
  const kind = classifyChatMessageKind(message, Boolean(timelineEntries?.length));
  return CHAT_MESSAGE_RENDERERS[kind](ctx);
}

/**
 * Shallow field-by-field equality for a single message part, one level deep into the nested
 * `resource` object for `{ type: 'resource' }` parts. Avoids `JSON.stringify`-based comparison,
 * which reallocates and serializes the whole structure on every render — expensive on the hot
 * path where `ChatMessage` re-renders on each streamed token.
 */
function arePartsEqual(previous?: ChatMessagePart[], next?: ChatMessagePart[]): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next || previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    const previousPart = previous[index];
    const nextPart = next[index];
    if (!previousPart || !nextPart || !isPartEqual(previousPart, nextPart)) {
      return false;
    }
  }
  return true;
}

function isPartEqual(previous: ChatMessagePart, next: ChatMessagePart): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.type !== next.type) {
    return false;
  }
  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  const nextKeys = Object.keys(nextRecord);
  if (previousKeys.length !== nextKeys.length) {
    return false;
  }
  for (const key of previousKeys) {
    const previousValue = previousRecord[key];
    const nextValue = nextRecord[key];
    if (previousValue === nextValue) {
      continue;
    }
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
  if (previousKeys.length !== nextKeys.length) {
    return false;
  }
  return previousKeys.every((key) => previous[key] === next[key]);
}

function areChatMessageActionPropsEqual(
  previous: ChatMessageProps,
  next: ChatMessageProps,
): boolean {
  return (
    previous.bridgeUrl === next.bridgeUrl &&
    previous.bridgeToken === next.bridgeToken &&
    previous.onOpenLocalPreview === next.onOpenLocalPreview &&
    previous.onOpenSubAgentThread === next.onOpenSubAgentThread &&
    previous.onForkConversation === next.onForkConversation &&
    previous.forkBusy === next.forkBusy
  );
}

/** Exported for direct unit testing of the memo comparator's field-aware equality. */
export function areChatMessagePropsEqual(
  previousProps: ChatMessageProps,
  nextProps: ChatMessageProps,
): boolean {
  const previous = previousProps.message;
  const next = nextProps.message;
  if (previous === next) {
    return true;
  }
  return (
    previous.id === next.id &&
    previous.role === next.role &&
    previous.content === next.content &&
    previous.createdAt === next.createdAt &&
    previous.completedAt === next.completedAt &&
    previous.pending === next.pending &&
    // Ordered parts take priority over `content` when rendering, so a parts-only
    // change still has to repaint the bubble.
    arePartsEqual(previous.parts, next.parts) &&
    (previous.role !== 'activity' ||
      next.role !== 'activity' ||
      previous.activityType === next.activityType) &&
    areChatMessageActionPropsEqual(previousProps, nextProps)
  );
}

export const ChatMessage = memo(ChatMessageComponent, areChatMessagePropsEqual);
ChatMessage.displayName = 'ChatMessage';
