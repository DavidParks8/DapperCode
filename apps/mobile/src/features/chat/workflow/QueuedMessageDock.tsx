import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { BridgeQueuedMessage } from '@bridge/types/types';
import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { queuedMessageStatusLabel } from '../helpers/helpers';
import { createStyles } from '../styles/styles';

interface QueuedMessageDockProps {
  queuedMessage: BridgeQueuedMessage;
  remainingQueuedMessagesCount: number;
  pendingSubmission: boolean;
  steerEnabled: boolean;
  cancelEnabled: boolean;
  editEnabled: boolean;
  steeringActive: boolean;
  steerPending: boolean;
  editing: boolean;
  waitingForToolCalls: boolean;
  steeringInFlight: boolean;
  steerDisabledReason: string | null;
  onCancelQueuedMessage: (messageId: string) => void;
  onCancelEdit: () => void;
  onEditQueuedMessage: (message: BridgeQueuedMessage) => void;
  onSteerQueuedMessage: () => void;
}

function QueueActionButtons({
  cancelEnabled,
  editing,
  queuedMessageId,
  steerDisabledReason,
  steerEnabled,
  steerPending,
  steeringActive,
  onCancelEdit,
  onCancelQueuedMessage,
  onSteerQueuedMessage,
  styles,
}: Pick<
  QueuedMessageDockProps,
  | 'cancelEnabled'
  | 'editing'
  | 'steerDisabledReason'
  | 'steerEnabled'
  | 'steerPending'
  | 'steeringActive'
  | 'onCancelEdit'
  | 'onCancelQueuedMessage'
  | 'onSteerQueuedMessage'
> & {
  queuedMessageId: string;
  styles: ReturnType<typeof createStyles>;
}) {
  if (editing) {
    return (
      <Pressable
        onPress={onCancelEdit}
        style={({ pressed }) => [
          styles.queuedMessageActionButton,
          pressed && styles.queuedMessageActionButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Discard queued message edits"
        accessibilityHint="Restores and resumes the original queued message"
      >
        <Text style={styles.queuedMessageActionLabel}>Discard</Text>
      </Pressable>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => onCancelQueuedMessage(queuedMessageId)}
        disabled={!cancelEnabled}
        style={({ pressed }) => [
          styles.queuedMessageActionButton,
          styles.queuedMessageActionButtonDestructive,
          !cancelEnabled && styles.queuedMessageActionButtonDisabled,
          pressed && cancelEnabled && styles.queuedMessageActionButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Cancel queued message"
        accessibilityState={controlAccessibilityState({ disabled: !cancelEnabled })}
      >
        <Text
          style={[
            styles.queuedMessageActionLabel,
            styles.queuedMessageActionLabelDestructive,
            !cancelEnabled && styles.queuedMessageActionLabelDisabled,
          ]}
        >
          Cancel
        </Text>
      </Pressable>
      {!steerPending ? (
        <Pressable
          onPress={onSteerQueuedMessage}
          disabled={!steerEnabled}
          style={({ pressed }) => [
            styles.queuedMessageActionButton,
            !steerEnabled && styles.queuedMessageActionButtonDisabled,
            pressed && steerEnabled && styles.queuedMessageActionButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={steeringActive ? 'Steering queued message' : 'Steer queued message'}
          accessibilityHint={steerDisabledReason ?? undefined}
          accessibilityState={controlAccessibilityState({
            disabled: !steerEnabled,
            busy: steeringActive,
          })}
        >
          <Text
            style={[
              styles.queuedMessageActionLabel,
              !steerEnabled && styles.queuedMessageActionLabelDisabled,
            ]}
          >
            {steeringActive ? 'Steering…' : 'Steer'}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}

export function QueuedMessageDock(props: QueuedMessageDockProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const {
    queuedMessage,
    remainingQueuedMessagesCount,
    pendingSubmission,
    editEnabled,
    steeringActive,
    steerPending,
    editing,
    waitingForToolCalls,
    steeringInFlight,
    steerDisabledReason,
    onEditQueuedMessage,
  } = props;
  const status = editing
    ? 'Editing queued message'
    : queuedMessageStatusLabel({
        pendingSubmission,
        steeringActive,
        steeringInFlight,
        steerPending,
        waitingForToolCalls,
      });

  return (
    <View style={styles.queuedMessageDock} accessibilityLiveRegion="polite">
      <View style={[styles.planCard, styles.planOverlayCard, styles.queuedMessageCard]}>
        <View style={styles.queuedMessageHeader}>
          <View style={styles.queuedMessageHeaderText}>
            <Text style={styles.planCardTitle}>{status}</Text>
            {remainingQueuedMessagesCount > 0 ? (
              <Text style={styles.queuedMessageSummary}>
                {`+${String(remainingQueuedMessagesCount)} more queued`}
              </Text>
            ) : null}
          </View>
          <View style={styles.queuedMessageActions}>
            <QueueActionButtons {...props} queuedMessageId={queuedMessage.id} styles={styles} />
          </View>
        </View>
        <Pressable
          onPress={() => onEditQueuedMessage(queuedMessage)}
          disabled={!editEnabled}
          style={({ pressed }) => [
            styles.queuedMessageBodyButton,
            pressed && editEnabled && styles.queuedMessageBodyButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Editing queued message' : 'Edit queued message'}
          accessibilityHint={
            editing
              ? 'The queue is paused until you save or discard your changes'
              : 'Pauses this message and opens it in the composer'
          }
          accessibilityState={controlAccessibilityState({ disabled: !editEnabled })}
        >
          <Text numberOfLines={3} style={styles.queuedMessageBody}>
            {queuedMessage.content}
          </Text>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={editing ? 'pause-circle-outline' : 'pencil-outline'}
            size={16}
            color={editing ? theme.colors.accent : theme.colors.textMuted}
          />
        </Pressable>
        {editing ? (
          <Text style={styles.queuedMessageHint}>
            Queue paused. Send your changes or discard them to resume the original.
          </Text>
        ) : steerDisabledReason ? (
          <Text style={styles.queuedMessageHint}>{steerDisabledReason}</Text>
        ) : null}
      </View>
    </View>
  );
}
