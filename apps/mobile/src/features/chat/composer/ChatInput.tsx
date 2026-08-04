import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextLayoutEvent,
  type TextInputKeyPressEvent,
  View,
} from 'react-native';

import { resolveComposerBottomSpacing } from './inputLayout';
import { createChatInputStyles } from './inputStyles';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { useAppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { GlassGroup } from '@shared/ui/glass/GlassGroup';
import { feedback } from '@shared/feedback';
import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';

const ACTION_BUTTON_PRESS_RETENTION_OFFSET = 8;
const ACTION_BUTTON_VISIBLE_SIZE = { width: 44, height: 44 };
const INPUT_TEXT_LINE_HEIGHT = 20;
const INPUT_TEXT_VERTICAL_PADDING = Platform.OS === 'ios' ? 2 : 0;
const INPUT_TEXT_MIN_HEIGHT = INPUT_TEXT_LINE_HEIGHT + INPUT_TEXT_VERTICAL_PADDING * 2;
const INPUT_TEXT_MAX_HEIGHT = 96;

interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttachPress: () => void;
  attachDisabled?: boolean;
  attachments?: Array<{ id: string; label: string }>;
  onRemoveAttachment?: (id: string) => void;
  isLoading: boolean;
  submitLabel?: string;
  submitHint?: string;
  submitDisabled?: boolean;
  showStopButton?: boolean;
  isStopping?: boolean;
  placeholder?: string;
  safeAreaBottomInset?: number;
  keyboardVisible?: boolean;
  footer?: ReactNode;
  reserveFooterSpace?: boolean;
}

interface ChatInputAttachmentListProps {
  attachments: Array<{ id: string; label: string }>;
  onRemoveAttachment?: (id: string) => void;
  hitSlop: ReturnType<typeof computeHitSlop>;
  styles: ReturnType<typeof createChatInputStyles>;
  textMutedColor: string;
}

function ChatInputAttachmentList({
  attachments,
  onRemoveAttachment,
  hitSlop,
  styles,
  textMutedColor,
}: ChatInputAttachmentListProps) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.attachmentListContent}
      style={styles.attachmentList}
    >
      {attachments.map((attachment, index) => (
        <Pressable
          key={`${attachment.id}-${String(index)}`}
          onPress={onRemoveAttachment ? () => onRemoveAttachment(attachment.id) : undefined}
          hitSlop={hitSlop}
          style={({ pressed }) => [styles.attachmentChip, pressed && styles.attachmentChipPressed]}
          accessibilityRole={onRemoveAttachment ? 'button' : undefined}
          accessibilityLabel={`${attachment.label}${onRemoveAttachment ? ', remove attachment' : ''}`}
          accessibilityHint={
            onRemoveAttachment ? 'Removes this attachment from the message' : undefined
          }
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="attach-outline"
            size={12}
            color={textMutedColor}
          />
          <Text style={styles.attachmentChipText} numberOfLines={1}>
            {attachment.label}
          </Text>
          {onRemoveAttachment ? (
            <Ionicons
              {...decorativeAccessibilityProps}
              name="close-outline"
              size={12}
              color={textMutedColor}
            />
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}

interface ChatInputStopButtonProps {
  onStop: () => void;
  isStopping: boolean;
  hitSlop: ReturnType<typeof computeHitSlop>;
  pressRetentionOffset: number;
  styles: ReturnType<typeof createChatInputStyles>;
  textMutedColor: string;
  textPrimaryColor: string;
}

function ChatInputStopButton({
  onStop,
  isStopping,
  hitSlop,
  pressRetentionOffset,
  styles,
  textMutedColor,
  textPrimaryColor,
}: ChatInputStopButtonProps) {
  return (
    <Pressable
      onPress={onStop}
      style={styles.sendBtn}
      disabled={isStopping}
      hitSlop={hitSlop}
      pressRetentionOffset={pressRetentionOffset}
      accessibilityRole="button"
      accessibilityLabel={isStopping ? 'Stopping agent' : 'Stop agent'}
      accessibilityHint="Stops the current turn"
      accessibilityState={controlAccessibilityState({
        disabled: isStopping,
        busy: isStopping,
      })}
    >
      <View style={styles.stopButtonContent}>
        {isStopping ? (
          <ActivityIndicator size="small" color={textMutedColor} />
        ) : (
          <Ionicons
            {...decorativeAccessibilityProps}
            name="square"
            size={10}
            color={textPrimaryColor}
          />
        )}
      </View>
    </Pressable>
  );
}

interface ChatInputSendButtonProps {
  onSubmit: () => void;
  canSend: boolean;
  isLoading: boolean;
  submitUsesPrimaryChrome: boolean;
  hitSlop: ReturnType<typeof computeHitSlop>;
  pressRetentionOffset: number;
  styles: ReturnType<typeof createChatInputStyles>;
  textMutedColor: string;
  textPrimaryColor: string;
  prominentTextColor: string;
  label: string;
  hint: string;
}

function ChatInputSendButton({
  onSubmit,
  canSend,
  isLoading,
  submitUsesPrimaryChrome,
  hitSlop,
  pressRetentionOffset,
  styles,
  textMutedColor,
  textPrimaryColor,
  prominentTextColor,
  label,
  hint,
}: ChatInputSendButtonProps) {
  const busy = isLoading && !canSend;
  return (
    <Pressable
      onPress={canSend ? onSubmit : undefined}
      style={styles.sendBtn}
      disabled={!canSend}
      hitSlop={hitSlop}
      pressRetentionOffset={pressRetentionOffset}
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Agent is responding' : label}
      accessibilityHint={hint}
      accessibilityState={controlAccessibilityState({ disabled: !canSend, busy })}
    >
      {busy ? (
        <ActivityIndicator
          size="small"
          color={submitUsesPrimaryChrome ? prominentTextColor : textMutedColor}
        />
      ) : (
        <Ionicons
          {...decorativeAccessibilityProps}
          name="arrow-up"
          size={16}
          color={submitUsesPrimaryChrome ? prominentTextColor : textPrimaryColor}
        />
      )}
    </Pressable>
  );
}

interface NormalizedChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttachPress: () => void;
  attachDisabled: boolean;
  attachments: Array<{ id: string; label: string }>;
  onRemoveAttachment?: (id: string) => void;
  isLoading: boolean;
  submitLabel: string;
  submitHint: string;
  submitDisabled: boolean;
  showStopButton: boolean;
  isStopping: boolean;
  placeholder: string;
  safeAreaBottomInset: number;
  keyboardVisible: boolean;
  footer: ReactNode;
  reserveFooterSpace: boolean;
}

function normalizeChatInputProps(props: ChatInputProps): NormalizedChatInputProps {
  return {
    value: props.value,
    onChangeText: props.onChangeText,
    onFocus: props.onFocus,
    onSubmit: props.onSubmit,
    onStop: props.onStop,
    onAttachPress: props.onAttachPress,
    attachDisabled: props.attachDisabled ?? false,
    attachments: props.attachments ?? [],
    onRemoveAttachment: props.onRemoveAttachment,
    isLoading: props.isLoading,
    submitLabel: props.submitLabel ?? 'Send message',
    submitHint: props.submitHint ?? 'Sends the current message',
    submitDisabled: props.submitDisabled ?? false,
    showStopButton: props.showStopButton ?? false,
    isStopping: props.isStopping ?? false,
    placeholder: props.placeholder ?? 'Message agent...',
    safeAreaBottomInset: props.safeAreaBottomInset ?? 0,
    keyboardVisible: props.keyboardVisible ?? false,
    footer: props.footer ?? null,
    reserveFooterSpace: props.reserveFooterSpace ?? false,
  };
}

export function ChatInput(props: ChatInputProps) {
  const {
    value,
    onChangeText,
    onFocus,
    onSubmit,
    onStop,
    onAttachPress,
    attachDisabled,
    attachments,
    onRemoveAttachment,
    isLoading,
    submitLabel,
    submitHint,
    submitDisabled,
    showStopButton,
    isStopping,
    placeholder,
    safeAreaBottomInset,
    keyboardVisible,
    footer,
    reserveFooterSpace,
  } = normalizeChatInputProps(props);
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createChatInputStyles(theme), [theme]);
  const actionButtonHitSlop = useMemo(() => computeHitSlop(ACTION_BUTTON_VISIBLE_SIZE), []);
  // Attachment chips vary in width with their label; the removal affordance shares the chip's
  // full Pressable area, so only vertical slop is needed and horizontal is capped to avoid
  // overlapping a neighboring chip in the tightly packed scroll row.
  const attachmentChipHitSlop = useMemo(
    () => computeHitSlop({ width: 44, height: 28 }, { maxHorizontal: theme.spacing.xs / 2 }),
    [theme],
  );
  const [inputHeight, setInputHeight] = useState(INPUT_TEXT_MIN_HEIGHT);
  const [inputWidth, setInputWidth] = useState(0);
  const updateInputHeight = (height: number) => {
    const nextHeight = Math.max(
      INPUT_TEXT_MIN_HEIGHT,
      Math.min(INPUT_TEXT_MAX_HEIGHT, Math.ceil(height)),
    );
    setInputHeight((previousHeight) =>
      previousHeight === nextHeight ? previousHeight : nextHeight,
    );
  };

  useEffect(() => {
    if (!value && inputHeight !== INPUT_TEXT_MIN_HEIGHT) {
      setInputHeight(INPUT_TEXT_MIN_HEIGHT);
    }
  }, [inputHeight, value]);

  const canSend = value.trim().length > 0 && !submitDisabled;
  const canStop = Boolean(showStopButton && onStop);
  const showSendButton = canSend || (isLoading && !canStop);
  const inputScrollEnabled = inputHeight >= INPUT_TEXT_MAX_HEIGHT;
  const submitUsesPrimaryChrome = canSend;
  const composerBottomSpacing = resolveComposerBottomSpacing(
    Platform.OS,
    safeAreaBottomInset,
    keyboardVisible,
  );

  const handleSubmit = () => {
    if (!canSend) {
      return;
    }
    void feedback.send();
    onSubmit();
  };

  const handleStop = () => {
    if (!onStop) {
      return;
    }
    void feedback.destructive();
    onStop();
  };

  return (
    <View style={styles.shell}>
      <View
        style={[
          styles.container,
          {
            paddingBottom: composerBottomSpacing.totalBottomPadding,
          },
        ]}
      >
        <GlassGroup
          spacing={theme.spacing.xs}
          style={styles.composerGroup}
          testID="composer-glass-group"
        >
          <GlassSurface
            isInteractive={!attachDisabled}
            role="capsule"
            style={styles.addButtonGlass}
            testID="composer-add-glass-surface"
          >
            <Pressable
              disabled={attachDisabled}
              onPress={onAttachPress}
              hitSlop={actionButtonHitSlop}
              style={[styles.plusBtn, attachDisabled && styles.plusBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
              accessibilityHint="Opens attachment choices"
              accessibilityState={controlAccessibilityState({ disabled: attachDisabled })}
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="add"
                size={21}
                color={colors.textPrimary}
              />
            </Pressable>
          </GlassSurface>

          <GlassSurface
            isInteractive
            role="capsule"
            style={[
              styles.composerBar,
              inputHeight > INPUT_TEXT_MIN_HEIGHT && styles.composerBarMultiline,
            ]}
            testID="composer-input-glass-surface"
          >
            <ChatInputAttachmentList
              attachments={attachments}
              onRemoveAttachment={onRemoveAttachment}
              hitSlop={attachmentChipHitSlop}
              styles={styles}
              textMutedColor={colors.textMuted}
            />
            <View style={styles.inputWrapper}>
              <Text
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  styles.inputMeasure,
                  {
                    width: inputWidth,
                    lineHeight: INPUT_TEXT_LINE_HEIGHT,
                    paddingVertical: INPUT_TEXT_VERTICAL_PADDING,
                  },
                ]}
                onTextLayout={(event: TextLayoutEvent) => {
                  if (inputWidth <= 0) {
                    return;
                  }
                  const lineCount = Math.max(1, event.nativeEvent.lines.length);
                  const measuredHeight =
                    lineCount * INPUT_TEXT_LINE_HEIGHT + INPUT_TEXT_VERTICAL_PADDING * 2;
                  updateInputHeight(measuredHeight);
                }}
              >
                {value.length > 0 ? `${value}\u200b` : ' '}
              </Text>
              <TextInput
                style={[styles.input, { height: inputHeight }]}
                value={value}
                onChangeText={onChangeText}
                keyboardAppearance={theme.keyboardAppearance}
                onLayout={(event) => {
                  const nextWidth = Math.floor(event.nativeEvent.layout.width);
                  setInputWidth((previousWidth) =>
                    previousWidth === nextWidth ? previousWidth : nextWidth,
                  );
                }}
                onFocus={onFocus}
                placeholder={placeholder}
                placeholderTextColor={colors.textMuted}
                multiline
                accessibilityLabel="Message"
                accessibilityHint="Enter a message for the agent"
                scrollEnabled={inputScrollEnabled}
                onKeyPress={(e: TextInputKeyPressEvent) => {
                  const keyEvent = e.nativeEvent as TextInputKeyPressEvent['nativeEvent'] & {
                    shiftKey?: boolean;
                  };
                  if (Platform.OS === 'web' && keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
            </View>
          </GlassSurface>

          {canStop ? (
            <GlassSurface
              isInteractive={!isStopping}
              role="capsule"
              style={styles.actionButtonGlass}
              testID="composer-stop-glass-surface"
            >
              <ChatInputStopButton
                onStop={handleStop}
                isStopping={isStopping}
                hitSlop={actionButtonHitSlop}
                pressRetentionOffset={ACTION_BUTTON_PRESS_RETENTION_OFFSET}
                styles={styles}
                textMutedColor={colors.textMuted}
                textPrimaryColor={colors.textPrimary}
              />
            </GlassSurface>
          ) : null}

          {showSendButton ? (
            <GlassSurface
              isInteractive={canSend}
              role={submitUsesPrimaryChrome ? 'prominent' : 'capsule'}
              style={styles.actionButtonGlass}
              testID="composer-submit-glass-surface"
            >
              <ChatInputSendButton
                onSubmit={handleSubmit}
                canSend={canSend}
                isLoading={isLoading}
                submitUsesPrimaryChrome={submitUsesPrimaryChrome}
                hitSlop={actionButtonHitSlop}
                pressRetentionOffset={ACTION_BUTTON_PRESS_RETENTION_OFFSET}
                styles={styles}
                textMutedColor={colors.textMuted}
                textPrimaryColor={colors.textPrimary}
                prominentTextColor={colors.userBubbleText}
                label={submitLabel}
                hint={submitHint}
              />
            </GlassSurface>
          ) : null}
        </GlassGroup>
        {footer || reserveFooterSpace ? (
          <View style={[styles.footer, !footer && styles.footerPlaceholder]}>{footer}</View>
        ) : null}
      </View>
    </View>
  );
}
