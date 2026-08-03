import { parseAgUiEventNotification } from '@bridge/agui/agUi';
import type { RpcNotification } from '@bridge/types/types';
import type { TurnCompletionSnapshot } from '@bridge/ws/types';
import { readIntegerLike } from '@shared/runtimeValidation';
import { EventType } from '@ag-ui/core';

export function readEventId(record: Record<string, unknown>): number | null {
  const eventId = readIntegerLike(record['eventId']);
  if (eventId === null || eventId < 1) {
    return null;
  }
  return eventId;
}

export function turnCompletionKey(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

export function toAgUiTurnCompletionSnapshot(
  event: RpcNotification,
): TurnCompletionSnapshot | null {
  const envelope = parseAgUiEventNotification(event);
  if (!envelope?.sourceTurnId) {
    return null;
  }
  if (envelope.event.type === EventType.RUN_FINISHED) {
    return {
      threadId: envelope.threadId,
      turnId: envelope.sourceTurnId,
      status: 'completed',
      errorMessage: null,
      completedAt: Date.now(),
    };
  }
  if (envelope.event.type === EventType.RUN_ERROR) {
    return {
      threadId: envelope.threadId,
      turnId: envelope.sourceTurnId,
      status: 'failed',
      errorMessage: envelope.event.message,
      completedAt: Date.now(),
    };
  }
  return null;
}

export function isFailedTurnStatus(status: string | null): boolean {
  return (
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'error' ||
    status === 'aborted' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}
