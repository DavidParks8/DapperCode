import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { ChatMessage, ToolInvocationRow } from '../message/ChatMessage';
import { ComputerUseTimeline } from '../message/ComputerUse';
import type { findInlineChoiceSet } from '../helpers/helpers';
import type { createStyles } from '../styles/styles';
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
  forkEligible: boolean;
  forkBusy: boolean;
  onForkConversation?: (messageId: string) => void;
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
  forkEligible,
  forkBusy,
  onForkConversation,
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
        />
      </View>
    );
  }

  const message = item.message;
  const showInlineChoices = inlineChoiceSet?.messageId === message.id;
  const chatMessage = (
    <ChatMessage
      message={message}
      bridgeUrl={bridgeUrl}
      bridgeToken={bridgeToken}
      onOpenLocalPreview={onOpenLocalPreview}
      onOpenSubAgentThread={onOpenSubAgentThread}
    />
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
  if (forkEligible) {
    return (
      <View style={styles.chatMessageBlock}>
        <View style={styles.forkCheckpoint}>
          <View style={styles.forkCheckpointLine} />
          <Pressable
            style={({ pressed }) => [
              styles.forkCheckpointButton,
              pressed && !forkBusy && styles.forkCheckpointButtonPressed,
            ]}
            disabled={forkBusy}
            onPress={() => onForkConversation?.(message.id)}
            accessibilityRole="button"
            accessibilityLabel="Fork conversation from this point"
            accessibilityHint="Creates a new conversation containing the completed requests before this one"
            accessibilityState={{ busy: forkBusy, disabled: forkBusy }}
          >
            {forkBusy ? (
              <ActivityIndicator size="small" />
            ) : (
              <Ionicons name="git-branch-outline" size={15} style={styles.forkCheckpointIcon} />
            )}
            <Text style={styles.forkCheckpointLabel}>
              {forkBusy ? 'Forking conversation' : 'Fork from here'}
            </Text>
          </Pressable>
          <View style={styles.forkCheckpointLine} />
        </View>
        {chatMessage}
        {inlineChoices}
      </View>
    );
  }
  return (
    <View style={styles.chatMessageBlock}>
      {chatMessage}
      {inlineChoices}
    </View>
  );
}
