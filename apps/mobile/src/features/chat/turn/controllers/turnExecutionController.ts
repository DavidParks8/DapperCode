import type { HostBridgeApiClient } from '@bridge/client/client';
import type { SendOrQueueChatMessageResult } from '@bridge/client/client';
import type {
  BridgeThreadQueueActionResponse,
  Chat,
  CreateChatRequest,
  SendChatMessageRequest,
} from '@bridge/types/types';

type TurnApi = Pick<
  HostBridgeApiClient,
  | 'createChatIdempotent'
  | 'sendChatMessageIdempotent'
  | 'sendOrQueueChatMessage'
  | 'interruptTurn'
  | 'interruptLatestTurn'
  | 'steerQueuedThreadMessage'
  | 'cancelQueuedThreadMessage'
  | 'startQueuedThreadMessageEdit'
  | 'commitQueuedThreadMessageEdit'
  | 'cancelQueuedThreadMessageEdit'
>;

export interface CreateAndStartTurnRequest {
  submissionId: string;
  create: CreateChatRequest;
  message: SendChatMessageRequest | ((chat: Chat) => SendChatMessageRequest);
  onCreated?: (chat: Chat) => void;
  onTurnStarted?: (threadId: string, turnId: string) => void;
}

export class TurnExecutionController {
  constructor(private readonly api: TurnApi) {}

  create(request: CreateChatRequest, submissionId: string): Promise<Chat> {
    return this.api.createChatIdempotent(request, submissionId);
  }

  send(
    threadId: string,
    message: SendChatMessageRequest,
    submissionId: string,
    onTurnStarted?: (turnId: string) => void,
  ): Promise<Chat> {
    return this.api.sendChatMessageIdempotent(
      threadId,
      message,
      submissionId,
      onTurnStarted ? { onTurnStarted } : undefined,
    );
  }

  async createAndStart(request: CreateAndStartTurnRequest): Promise<Chat> {
    const created = await this.create(request.create, request.submissionId);
    request.onCreated?.(created);
    const message =
      typeof request.message === 'function' ? request.message(created) : request.message;
    return this.send(created.id, message, request.submissionId, (turnId) =>
      request.onTurnStarted?.(created.id, turnId),
    );
  }

  sendOrQueue(
    threadId: string,
    message: SendChatMessageRequest,
    skipResume: boolean,
    submissionId: string,
  ): Promise<SendOrQueueChatMessageResult> {
    return this.api.sendOrQueueChatMessage(threadId, message, { skipResume, submissionId });
  }

  async interrupt(threadId: string, turnId?: string | null): Promise<string | null> {
    if (turnId) {
      await this.api.interruptTurn(threadId, turnId);
      return turnId;
    }
    return this.api.interruptLatestTurn(threadId);
  }

  steer(threadId: string, messageId: string): Promise<BridgeThreadQueueActionResponse> {
    return this.api.steerQueuedThreadMessage(threadId, messageId);
  }

  cancelQueued(threadId: string, messageId: string): Promise<BridgeThreadQueueActionResponse> {
    return this.api.cancelQueuedThreadMessage(threadId, messageId);
  }

  startQueuedEdit(threadId: string, messageId: string): Promise<BridgeThreadQueueActionResponse> {
    return this.api.startQueuedThreadMessageEdit(threadId, messageId);
  }

  commitQueuedEdit(
    threadId: string,
    messageId: string,
    content: string,
  ): Promise<BridgeThreadQueueActionResponse> {
    return this.api.commitQueuedThreadMessageEdit(threadId, messageId, content);
  }

  cancelQueuedEdit(threadId: string, messageId: string): Promise<BridgeThreadQueueActionResponse> {
    return this.api.cancelQueuedThreadMessageEdit(threadId, messageId);
  }
}
