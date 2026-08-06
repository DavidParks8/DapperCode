import { Pressable, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { ChatMessage, ToolInvocationRow } from '../message/ChatMessage';
import { ComputerUseTimeline } from '../message/ComputerUse';
import type { findInlineChoiceSet } from '../helpers/helpers';
import type { createStyles } from '../styles/styles';
import { MessageTimestampReveal } from './MessageTimestampReveal';
import { resolveMessageTimestamp } from './messageTimestamp';
import type { TranscriptDisplayItem } from './messages';

type ChatTranscriptStyles = ReturnType<typeof createStyles>;
type InlineChoiceSet = ReturnType<typeof findInlineChoiceSet>;

interface RenderChatTranscriptItemOptions {
  item: TranscriptDisplayItem;
  styles: ChatTranscriptStyles;
  bridgeUrl: string;
  bridgeToken: string | null;
  inlineChoiceSet: InlineChoiceSet;
  onInlineOptionSelect: (value: string) => void;
  onOpenLocalPreview?: (targetUrl: string) => void;
  onOpenSubAgentThread?: (threadId: string) => void;
  forkBoundaryMessageId?: string;
  forkBusy: boolean;
  onForkConversation?: (messageId: string) => void;
  timestampRevealTranslationX: SharedValue<number>;
  threadRunning: boolean;
}

export function renderChatTranscriptItem({
  item,
  styles,
  bridgeUrl,
  bridgeToken,
  inlineChoiceSet,
  onInlineOptionSelect,
  onOpenLocalPreview,
  onOpenSubAgentThread,
  forkBoundaryMessageId,
  forkBusy,
  onForkConversation,
  timestampRevealTranslationX,
  threadRunning,
}: RenderChatTranscriptItemOptions) {
  if (item.kind === 'toolGroup') {
    return (
      <View style={styles.chatMessageBlock}>
        <ComputerUseTimeline
          entries={item.invocations.map((invocation) => ({
            id: invocation.id,
            title: invocation.title.includes('`') ? invocation.title : `\`${invocation.title}\``,
            details: invocation.textLines,
          }))}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
        />
      </View>
    );
  }

  if (item.kind === 'toolInvocation') {
    return (
      <View style={styles.chatMessageBlock}>
        <ToolInvocationRow
          invocation={item.invocation}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
          threadRunning={threadRunning}
        />
      </View>
    );
  }

  const message = item.message;
  const showInlineChoices = inlineChoiceSet?.messageId === message.id;
  const chatMessageContent = (
    <ChatMessage
      message={message}
      bridgeUrl={bridgeUrl}
      bridgeToken={bridgeToken}
      onOpenLocalPreview={onOpenLocalPreview}
      onOpenSubAgentThread={onOpenSubAgentThread}
      onForkConversation={
        forkBoundaryMessageId ? () => onForkConversation?.(forkBoundaryMessageId) : undefined
      }
      forkBusy={forkBusy}
    />
  );
  const timestamp = resolveMessageTimestamp(message);
  const chatMessage = timestamp ? (
    <MessageTimestampReveal
      messageId={message.id}
      timestamp={timestamp}
      translationX={timestampRevealTranslationX}
    >
      {chatMessageContent}
    </MessageTimestampReveal>
  ) : (
    chatMessageContent
  );
  const inlineChoices = showInlineChoices ? (
    <View style={styles.inlineChoiceOptions}>
      {inlineChoiceSet.options.map((option, index) => (
        <Pressable
          key={`${message.id}-${index}-${option.label}`}
          style={({ pressed }) => [
            styles.inlineChoiceOptionButton,
            pressed && styles.inlineChoiceOptionButtonPressed,
          ]}
          onPress={() => onInlineOptionSelect(option.label)}
          accessibilityRole="button"
          accessibilityLabel={option.label}
          accessibilityHint={option.description || 'Fills the reply box with this answer'}
        >
          <View style={styles.inlineChoiceOptionRow}>
            <Text style={styles.inlineChoiceOptionIndex}>{`${String(index + 1)}.`}</Text>
            <Text style={styles.inlineChoiceOptionLabel}>{option.label}</Text>
          </View>
          {option.description.trim() ? (
            <Text style={styles.inlineChoiceOptionDescription}>{option.description}</Text>
          ) : null}
        </Pressable>
      ))}
      <Text style={styles.inlineChoiceHint}>Tap an option to fill the reply box.</Text>
    </View>
  ) : null;
  return (
    <View style={styles.chatMessageBlock}>
      {chatMessage}
      {inlineChoices}
    </View>
  );
}
