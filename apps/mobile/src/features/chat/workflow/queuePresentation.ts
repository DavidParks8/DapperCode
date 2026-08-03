import type { ThreadRuntimeSnapshot } from '../helpers/helpers';

export function resolveQueuedMessageSteerDisabledReason(options: {
  showingOptimisticQueuedMessage: boolean;
  selectedQueueError: ThreadRuntimeSnapshot['queuedMessageError'] | null;
  queueActionKind: string | null;
  editingQueuedMessage: boolean;
  supportsSteer: boolean;
}): string | null {
  if (options.showingOptimisticQueuedMessage) {
    return 'Sending the queued message to the bridge.';
  }
  if (options.selectedQueueError?.message) {
    return options.selectedQueueError.message;
  }
  if (options.editingQueuedMessage) {
    return 'Save or discard the queued message edit before steering.';
  }
  const actionMessages: Record<string, string> = {
    steer: 'Sending the queued message to the current turn.',
    cancel: 'Removing the queued message.',
    editStart: 'Pausing the queued message for editing.',
    editCommit: 'Saving the queued message edit.',
    editCancel: 'Resuming the original queued message.',
  };
  if (options.queueActionKind) {
    return actionMessages[options.queueActionKind] ?? null;
  }
  return options.supportsSteer ? null : 'The active agent does not support steering.';
}
