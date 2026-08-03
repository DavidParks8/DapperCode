import { QueuedMessageDock } from '../workflow/QueuedMessageDock';
import type { MainScreenComposerRendererContext } from './renderer';

export interface QueuedMessageDockViewProps {
  showQueuedMessageDock: boolean;
  oldestQueuedMessage: MainScreenComposerRendererContext['oldestQueuedMessage'];
  remainingQueuedMessagesCount: MainScreenComposerRendererContext['remainingQueuedMessagesCount'];
  showingOptimisticQueuedMessage: MainScreenComposerRendererContext['showingOptimisticQueuedMessage'];
  canSteerQueuedMessage: MainScreenComposerRendererContext['canSteerQueuedMessage'];
  canCancelQueuedMessage: MainScreenComposerRendererContext['canCancelQueuedMessage'];
  canEditQueuedMessage: MainScreenComposerRendererContext['canEditQueuedMessage'];
  queueActionItemId: string | null;
  queueActionKind: string | null;
  oldestQueuedMessageIsPendingSteer: MainScreenComposerRendererContext['oldestQueuedMessageIsPendingSteer'];
  editingQueuedMessage: MainScreenComposerRendererContext['editingQueuedMessage'];
  selectedThreadRuntimeSnapshot: MainScreenComposerRendererContext['selectedThreadRuntimeSnapshot'];
  queuedMessageSteerDisabledReason: MainScreenComposerRendererContext['queuedMessageSteerDisabledReason'];
  handleCancelQueuedMessage: MainScreenComposerRendererContext['handleCancelQueuedMessage'];
  handleCancelQueuedMessageEdit: MainScreenComposerRendererContext['handleCancelQueuedMessageEdit'];
  handleEditQueuedMessage: MainScreenComposerRendererContext['handleEditQueuedMessage'];
  handleSteerQueuedMessage: MainScreenComposerRendererContext['handleSteerQueuedMessage'];
}

export function QueuedMessageDockView(props: QueuedMessageDockViewProps) {
  const { showQueuedMessageDock, oldestQueuedMessage } = props;
  if (!showQueuedMessageDock || !oldestQueuedMessage) {
    return null;
  }

  return (
    <QueuedMessageDock
      queuedMessage={oldestQueuedMessage}
      remainingQueuedMessagesCount={props.remainingQueuedMessagesCount}
      pendingSubmission={props.showingOptimisticQueuedMessage}
      steerEnabled={props.canSteerQueuedMessage}
      cancelEnabled={props.canCancelQueuedMessage}
      editEnabled={props.canEditQueuedMessage}
      steeringActive={
        props.queueActionKind === 'steer' && props.queueActionItemId === oldestQueuedMessage.id
      }
      steerPending={props.oldestQueuedMessageIsPendingSteer}
      editing={props.editingQueuedMessage}
      waitingForToolCalls={props.selectedThreadRuntimeSnapshot?.waitingForToolCalls === true}
      steeringInFlight={props.selectedThreadRuntimeSnapshot?.steeringInFlight === true}
      steerDisabledReason={props.queuedMessageSteerDisabledReason}
      onCancelQueuedMessage={(messageId) => {
        void props.handleCancelQueuedMessage(messageId);
      }}
      onCancelEdit={() => {
        void props.handleCancelQueuedMessageEdit();
      }}
      onEditQueuedMessage={(message) => {
        void props.handleEditQueuedMessage(message);
      }}
      onSteerQueuedMessage={() => {
        void props.handleSteerQueuedMessage();
      }}
    />
  );
}
