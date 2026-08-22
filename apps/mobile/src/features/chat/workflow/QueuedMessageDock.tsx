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
  agentEntry,
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
  agentEntry: boolean;
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
      {!agentEntry && !steerPending ? (
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

interface QueuePresentation {
  agentEntry: boolean;
  bodyHint: string;
  bodyLabel: string;
  editEnabled: boolean;
  editing: boolean;
  footerHint: string | null;
  icon: 'arrow-down-circle-outline' | 'pause-circle-outline' | 'pencil-outline';
  status: string;
  steerPending: boolean;
}

function queuePresentation(props: QueuedMessageDockProps): QueuePresentation {
  const agentMessage = props.queuedMessage.agentMessage;
  if (agentMessage) {
    const relatedAgent =
      agentMessage.relatedTitle?.trim() || agentMessage.relatedThreadId || 'agent';
    const relation = agentMessage.relation === 'parent' ? 'parent' : 'sub-agent';
    return {
      agentEntry: true,
      bodyHint: 'Queued agent messages are read only',
      bodyLabel: `Queued message received from ${relation} ${relatedAgent}`,
      editEnabled: false,
      editing: false,
      footerHint: null,
      icon: 'arrow-down-circle-outline',
      status: `Received from ${relation} · ${relatedAgent}`,
      steerPending: false,
    };
  }
  if (props.editing) {
    return {
      agentEntry: false,
      bodyHint: 'The queue is paused until you save or discard your changes',
      bodyLabel: 'Editing queued message',
      editEnabled: props.editEnabled,
      editing: true,
      footerHint: 'Queue paused. Send your changes or discard them to resume the original.',
      icon: 'pause-circle-outline',
      status: 'Editing queued message',
      steerPending: props.steerPending,
    };
  }
  return {
    agentEntry: false,
    bodyHint: 'Pauses this message and opens it in the composer',
    bodyLabel: 'Edit queued message',
    editEnabled: props.editEnabled,
    editing: false,
    footerHint: props.steerDisabledReason,
    icon: 'pencil-outline',
    status: queuedMessageStatusLabel(props),
    steerPending: props.steerPending,
  };
}

export function QueuedMessageDock(props: QueuedMessageDockProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { queuedMessage, remainingQueuedMessagesCount, onEditQueuedMessage } = props;
  const presentation = queuePresentation(props);

  return (
    <View style={styles.queuedMessageDock} accessibilityLiveRegion="polite">
      <View style={[styles.planCard, styles.planOverlayCard, styles.queuedMessageCard]}>
        <View style={styles.queuedMessageHeader}>
          <View style={styles.queuedMessageHeaderText}>
            <Text style={styles.planCardTitle}>{presentation.status}</Text>
            {remainingQueuedMessagesCount > 0 ? (
              <Text style={styles.queuedMessageSummary}>
                {`+${String(remainingQueuedMessagesCount)} more queued`}
              </Text>
            ) : null}
          </View>
          <View style={styles.queuedMessageActions}>
            <QueueActionButtons
              {...props}
              editing={presentation.editing}
              steerPending={presentation.steerPending}
              agentEntry={presentation.agentEntry}
              queuedMessageId={queuedMessage.id}
              styles={styles}
            />
          </View>
        </View>
        <Pressable
          onPress={() => onEditQueuedMessage(queuedMessage)}
          disabled={!presentation.editEnabled}
          style={({ pressed }) => [
            styles.queuedMessageBodyButton,
            pressed && presentation.editEnabled && styles.queuedMessageBodyButtonPressed,
          ]}
          accessibilityRole={presentation.editEnabled ? 'button' : undefined}
          accessibilityLabel={presentation.bodyLabel}
          accessibilityHint={presentation.bodyHint}
          accessibilityState={controlAccessibilityState({ disabled: !presentation.editEnabled })}
        >
          <Text numberOfLines={3} style={styles.queuedMessageBody}>
            {queuedMessage.content}
          </Text>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={presentation.icon}
            size={16}
            color={presentation.editing ? theme.colors.accent : theme.colors.textMuted}
          />
        </Pressable>
        {presentation.footerHint ? (
          <Text style={styles.queuedMessageHint}>{presentation.footerHint}</Text>
        ) : null}
      </View>
    </View>
  );
}
