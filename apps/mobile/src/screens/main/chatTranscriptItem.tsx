import { Pressable, Text, View } from 'react-native';

import { ChatMessage, ToolActivityGroup } from '../../components/ChatMessage';
import type { findInlineChoiceSet } from './mainScreenHelpers';
import type { createStyles } from './mainScreenStyles';
import type { TranscriptDisplayItem } from './transcriptMessages';

type ChatTranscriptStyles = ReturnType<typeof createStyles>;
type InlineChoiceSet = ReturnType<typeof findInlineChoiceSet>;

interface RenderChatTranscriptItemOptions {
  item: TranscriptDisplayItem;
  styles: ChatTranscriptStyles;
  bridgeUrl: string;
  bridgeToken: string | null;
  liveTurnActive: boolean;
  inlineChoiceSet: InlineChoiceSet;
  onInlineOptionSelect: (value: string) => void;
  onOpenLocalPreview?: (targetUrl: string) => void;
  onOpenSubAgentThread?: (threadId: string) => void;
}

export function renderChatTranscriptItem({
  item,
  styles,
  bridgeUrl,
  bridgeToken,
  liveTurnActive,
  inlineChoiceSet,
  onInlineOptionSelect,
  onOpenLocalPreview,
  onOpenSubAgentThread,
}: RenderChatTranscriptItemOptions) {
  if (item.kind === 'toolGroup') {
    return (
      <View style={styles.chatMessageBlock}>
        <ToolActivityGroup
          messages={item.messages}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
          liveTurnActive={liveTurnActive}
        />
      </View>
    );
  }

  const message = item.message;
  const showInlineChoices = inlineChoiceSet?.messageId === message.id;
  return (
    <View style={styles.chatMessageBlock}>
      <ChatMessage
        message={message}
        bridgeUrl={bridgeUrl}
        bridgeToken={bridgeToken}
        onOpenLocalPreview={onOpenLocalPreview}
        onOpenSubAgentThread={onOpenSubAgentThread}
      />
      {showInlineChoices ? (
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
                <Text style={styles.inlineChoiceOptionDescription}>
                  {option.description}
                </Text>
              ) : null}
            </Pressable>
          ))}
          <Text style={styles.inlineChoiceHint}>
            Tap an option to fill the reply box.
          </Text>
        </View>
      ) : null}
    </View>
  );
}