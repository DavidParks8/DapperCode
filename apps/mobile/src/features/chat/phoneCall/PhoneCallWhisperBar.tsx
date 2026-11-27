import { Ionicons } from '@expo/vector-icons';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import type { AppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import type { createPhoneCallStageStyles } from './phoneCallStageStyles';

export const QUICK_WHISPER_CHIPS = [
  { label: 'Wrap up', instruction: 'Wrap up the conversation politely and hang up.' },
  { label: 'Ask for callback', instruction: 'Ask if they can call back with an update.' },
  { label: 'Wait on hold', instruction: 'Stay quiet and wait patiently on hold.' },
  { label: 'Ask for a human', instruction: 'Ask to speak with a human representative.' },
] as const;

export function StageWhisperBar({
  isSheet,
  draft,
  whisperState,
  onChangeDraft,
  onSubmitDraft,
  onQuickWhisper,
  styles,
  theme,
}: {
  isSheet: boolean;
  draft: string;
  whisperState: 'idle' | 'sending' | 'sent' | 'failed';
  onChangeDraft: (value: string) => void;
  onSubmitDraft: () => void;
  onQuickWhisper: (instruction: string) => void;
  styles: ReturnType<typeof createPhoneCallStageStyles>;
  theme: AppTheme;
}) {
  const InputComponent = isSheet && Platform.OS !== 'web' ? BottomSheetTextInput : TextInput;
  const canSend = draft.trim().length > 0 && whisperState !== 'sending';
  const sendHitSlop = useMemo(() => computeHitSlop({ width: 42, height: 42 }), []);
  const chipHitSlop = useMemo(
    () => computeHitSlop({ width: 88, height: 34 }, { maxHorizontal: 3 }),
    [],
  );

  return (
    <View
      style={[styles.whisperSection, isSheet && styles.whisperSectionSheet]}
      testID="phone-call-whisper-bar"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.quickChipsContent}
      >
        {QUICK_WHISPER_CHIPS.map((chip) => (
          <Pressable
            key={chip.label}
            disabled={whisperState === 'sending'}
            onPress={() => onQuickWhisper(chip.instruction)}
            hitSlop={chipHitSlop}
            style={({ pressed }) => [styles.quickChip, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Whisper: ${chip.label}`}
            testID={`phone-call-whisper-chip-${chip.label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <Text style={styles.quickChipText}>{chip.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.whisperInputRow}>
        <InputComponent
          value={draft}
          onChangeText={onChangeDraft}
          placeholder="Whisper to agent…"
          placeholderTextColor={theme.colors.textMuted}
          keyboardAppearance={theme.keyboardAppearance}
          multiline
          editable={whisperState !== 'sending'}
          style={styles.whisperInput}
          accessibilityLabel="Whisper to agent"
          testID="phone-call-whisper-input"
        />
        <Pressable
          onPress={onSubmitDraft}
          disabled={!canSend}
          hitSlop={sendHitSlop}
          style={({ pressed }) => [
            styles.whisperSendButton,
            !canSend && styles.whisperSendDisabled,
            pressed && canSend && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Send whisper"
          accessibilityState={controlAccessibilityState({
            disabled: !canSend,
            busy: whisperState === 'sending',
          })}
          testID="phone-call-whisper-send"
        >
          {whisperState === 'sending' ? (
            <ActivityIndicator size="small" color={theme.colors.accentText} />
          ) : (
            <Ionicons
              {...decorativeAccessibilityProps}
              name="arrow-up"
              size={18}
              color={canSend ? theme.colors.accentText : theme.colors.textMuted}
            />
          )}
        </Pressable>
      </View>
      {whisperState === 'sent' ? (
        <Text style={styles.whisperFeedback} testID="phone-call-whisper-feedback">
          Whisper queued for agent’s next turn
        </Text>
      ) : whisperState === 'failed' ? (
        <Text
          style={[styles.whisperFeedback, styles.whisperFeedbackError]}
          accessibilityRole="alert"
          testID="phone-call-whisper-feedback"
        >
          Couldn’t send whisper. Try again.
        </Text>
      ) : null}
    </View>
  );
}
