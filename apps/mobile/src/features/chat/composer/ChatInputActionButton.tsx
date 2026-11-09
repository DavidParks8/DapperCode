import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import type { computeHitSlop } from '@shared/ui/touchTarget';
import type { createChatInputStyles } from './inputStyles';

interface ChatInputActionButtonProps {
  onSubmit: () => void;
  onStop: () => void;
  canSend: boolean;
  canStop: boolean;
  isLoading: boolean;
  isUploading: boolean;
  isStopping: boolean;
  hitSlop: ReturnType<typeof computeHitSlop>;
  pressRetentionOffset: number;
  styles: ReturnType<typeof createChatInputStyles>;
  textMutedColor: string;
  textPrimaryColor: string;
  label: string;
  hint: string;
}

interface ChatInputActionState {
  accessibilityHint: string;
  accessibilityLabel: string;
  busy: boolean;
  enabled: boolean;
  kind: 'send' | 'stop';
  slotTestID: string;
  surfaceTestID: string;
}

function resolveChatInputActionState({
  canSend,
  canStop,
  isLoading,
  isUploading,
  isStopping,
  label,
  hint,
}: Pick<
  ChatInputActionButtonProps,
  'canSend' | 'canStop' | 'isLoading' | 'isUploading' | 'isStopping' | 'label' | 'hint'
>): ChatInputActionState {
  if (canStop && !canSend) {
    return {
      accessibilityHint: 'Stops the current turn',
      accessibilityLabel: isStopping ? 'Stopping agent' : 'Stop agent',
      busy: isStopping,
      enabled: !isStopping,
      kind: 'stop',
      slotTestID: 'composer-stop-slot',
      surfaceTestID: 'composer-stop-glass-surface',
    };
  }

  const busy = isLoading && !canSend;
  return {
    accessibilityHint: hint,
    accessibilityLabel: busy
      ? isUploading
        ? 'Preparing attachment'
        : 'Agent is responding'
      : label,
    busy,
    enabled: canSend,
    kind: 'send',
    slotTestID: 'composer-submit-slot',
    surfaceTestID: 'composer-submit-glass-surface',
  };
}

function ChatInputActionGlyph({
  action,
  styles,
  textMutedColor,
  textPrimaryColor,
}: {
  action: ChatInputActionState;
  styles: ReturnType<typeof createChatInputStyles>;
  textMutedColor: string;
  textPrimaryColor: string;
}) {
  if (action.busy) {
    return <ActivityIndicator size="small" color={textMutedColor} />;
  }
  if (action.kind === 'stop') {
    return (
      <View style={styles.stopButtonContent}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name="square"
          size={10}
          color={textPrimaryColor}
        />
      </View>
    );
  }
  return (
    <Ionicons
      {...decorativeAccessibilityProps}
      name="arrow-up"
      size={16}
      color={textPrimaryColor}
    />
  );
}

export function ChatInputActionButton({
  onSubmit,
  onStop,
  canSend,
  canStop,
  isLoading,
  isUploading,
  isStopping,
  hitSlop,
  pressRetentionOffset,
  styles,
  textMutedColor,
  textPrimaryColor,
  label,
  hint,
}: ChatInputActionButtonProps) {
  const action = resolveChatInputActionState({
    canSend,
    canStop,
    isLoading,
    isUploading,
    isStopping,
    label,
    hint,
  });
  return (
    <View collapsable={false} style={styles.actionButtonFrame} testID={action.slotTestID}>
      <Pressable
        onPress={() => {
          if (!action.enabled) {
            return;
          }
          if (action.kind === 'stop') {
            onStop();
          } else {
            onSubmit();
          }
        }}
        style={({ pressed }) => [
          styles.actionButtonPressable,
          pressed && action.enabled && styles.actionButtonPressed,
        ]}
        hitSlop={hitSlop}
        pressRetentionOffset={pressRetentionOffset}
        accessibilityRole="button"
        accessibilityLabel={action.accessibilityLabel}
        accessibilityHint={action.accessibilityHint}
        accessibilityState={controlAccessibilityState({
          disabled: !action.enabled,
          busy: action.busy,
        })}
      >
        <GlassSurface
          pointerEvents="none"
          role="capsule"
          style={styles.actionButtonGlass}
          testID={action.surfaceTestID}
        >
          <View pointerEvents="none" style={styles.actionButtonOutline} />
          <ChatInputActionGlyph
            action={action}
            styles={styles}
            textMutedColor={textMutedColor}
            textPrimaryColor={textPrimaryColor}
          />
        </GlassSurface>
      </Pressable>
    </View>
  );
}
