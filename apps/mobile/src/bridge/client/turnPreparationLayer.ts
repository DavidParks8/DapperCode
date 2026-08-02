import { HostBridgeApiClientBridgeActionsLayer } from '@bridge/client/bridgeActionsLayer';
import {
  appendSyntheticUserMessage,
  isMaterializationGapError,
  isTransientThreadReadError,
  preserveCachedTranscript,
  sleep,
} from '@bridge/client/clientChatCloneAndRetryInternals';
import {
  buildTurnInput,
  chatHasRecentUserMessage,
  normalizeAgentName,
  normalizeCollaborationMode,
  normalizeLocalImages,
  normalizeMentions,
  rawThreadHasTurns,
  rawThreadHasTurnUserMessage,
  toTurnCollaborationMode,
} from '@bridge/client/clientTurnInputInternals';
import { mapChat, type RawThread, toRawThread } from '@bridge/mapping/chatMapping';
import {
  normalizeApprovalPolicy,
  normalizeEffort,
  normalizeModel,
  normalizeServiceTier,
} from '@bridge/client/clientBridgeResponseNormalization';
import { normalizeCwd } from '@bridge/client/clientChatListInternals';
import {
  type AppServerReadResponse,
  type AppServerThreadRuntimeSettings,
  type ChatSnapshot,
  type PreparedTurnRequest,
  type PrepareTurnRequestOptions,
  TRANSIENT_THREAD_READ_RETRY_DELAYS_MS,
  type TurnInputLocalImage,
  type TurnInputMention,
} from '@bridge/client/clientContractsAndSnapshotInternals';
import type {
  Chat,
  ChatSummary,
  GitPushResponse,
  SendChatMessageRequest,
} from '@bridge/types/types';

function emptyPreparedTurn(threadId: string): PreparedTurnRequest {
  return {
    content: '',
    mentions: [],
    localImages: [],
    turnStartParams: { threadId, input: [] },
  };
}

export abstract class HostBridgeApiClientTurnPreparationLayer extends HostBridgeApiClientBridgeActionsLayer {
  gitPush(cwd?: string): Promise<GitPushResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitPushResponse>('bridge/git/push', {
      cwd: normalizedCwd ?? null,
    });
  }
  protected async prepareTurnRequest(
    id: string,
    body: SendChatMessageRequest,
    options?: PrepareTurnRequestOptions,
  ): Promise<PreparedTurnRequest> {
    const content = body.content.trim();
    if (!content) {
      return emptyPreparedTurn(id);
    }
    if ((body.role ?? 'user') !== 'user') {
      throw new Error('Only user role is supported in bridge/chat messaging');
    }
    return this.prepareNonEmptyTurnRequest(id, content, this.readTurnSettings(body), options);
  }
  private readTurnSettings(body: SendChatMessageRequest) {
    return {
      cwd: normalizeCwd(body.cwd),
      model: normalizeModel(body.model),
      effort: normalizeEffort(body.effort),
      serviceTier: normalizeServiceTier(body.serviceTier),
      approvalPolicy: normalizeApprovalPolicy(body.approvalPolicy) ?? 'untrusted',
      mentions: normalizeMentions(body.mentions),
      localImages: normalizeLocalImages(body.localImages),
      collaborationMode: normalizeCollaborationMode(body.collaborationMode),
      agent: normalizeAgentName(body.agent),
    };
  }
  private async prepareNonEmptyTurnRequest(
    id: string,
    content: string,
    settings: ReturnType<HostBridgeApiClientTurnPreparationLayer['readTurnSettings']>,
    options: PrepareTurnRequestOptions | undefined,
  ): Promise<PreparedTurnRequest> {
    const resumedThreadSettings = await this.resumeTurnThread(id, options, {
      model: settings.model,
      cwd: settings.cwd,
      approvalPolicy: settings.approvalPolicy,
    });
    const effectiveModel = settings.model ?? resumedThreadSettings?.model ?? null;
    const effectiveEffort = settings.collaborationMode
      ? (settings.effort ?? resumedThreadSettings?.effort ?? null)
      : settings.effort;
    const normalizedCollaborationMode = toTurnCollaborationMode(
      settings.collaborationMode,
      effectiveModel,
      effectiveEffort,
    );
    return {
      content,
      mentions: settings.mentions,
      localImages: settings.localImages,
      turnStartParams: {
        threadId: id,
        input: buildTurnInput(content, settings.mentions, settings.localImages),
        cwd: settings.cwd ?? null,
        approvalPolicy: settings.approvalPolicy,
        sandboxPolicy: null,
        model: effectiveModel ?? null,
        effort: effectiveEffort ?? null,
        serviceTier: settings.serviceTier ?? null,
        summary: 'auto',
        personality: null,
        outputSchema: null,
        collaborationMode: normalizedCollaborationMode,
        agent: settings.agent,
      },
    };
  }
  private async resumeTurnThread(
    threadId: string,
    options: PrepareTurnRequestOptions | undefined,
    settings: {
      model: string | null;
      cwd: string | null;
      approvalPolicy: NonNullable<ReturnType<typeof normalizeApprovalPolicy>>;
    },
  ): Promise<AppServerThreadRuntimeSettings | null> {
    if (options?.skipResume) {
      return null;
    }
    return this.resumeThread(threadId, settings);
  }
  protected mapChatWithCachedTitle(rawThreadValue: unknown): Chat {
    const rawThread = toRawThread(rawThreadValue);
    this.rememberRawThreadTitle(rawThread);
    const mapped = mapChat(rawThread);
    const chat = this.applyRememberedTitle(mapped);
    this.rememberChat(chat);
    return chat;
  }
  protected rememberRawThreadTitle(rawThread: RawThread): void {
    const threadId = rawThread.id?.trim();
    const rawTitle = rawThread.name?.trim();
    if (!threadId || !rawTitle) {
      return;
    }
    this.renamedTitles.set(threadId, rawTitle);
  }
  protected applyRememberedTitle<T extends ChatSummary>(mapped: T): T {
    const cachedTitle = this.renamedTitles.get(mapped.id);
    if (!cachedTitle) {
      return mapped;
    }
    return { ...mapped, title: cachedTitle };
  }
  protected async readChatSnapshot(id: string): Promise<ChatSnapshot> {
    try {
      const response = await this.readAppServerThread(id, true);
      const rawThread = toRawThread(response.thread);
      return { rawThread, chat: this.mapChatWithCachedTitle(rawThread) };
    } catch (error) {
      if (!isMaterializationGapError(error)) {
        throw error;
      }
      const response = await this.readAppServerThread(id, false);
      const rawThread = toRawThread(response.thread);
      const cached = this.peekChat(id);
      this.rememberRawThreadTitle(rawThread);
      const chat = preserveCachedTranscript(cached, this.applyRememberedTitle(mapChat(rawThread)));
      this.rememberChat(chat);
      return { rawThread, chat };
    }
  }
  protected async readAppServerThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<AppServerReadResponse> {
    let lastTransientError: unknown = null;
    for (let attempt = 0; attempt <= TRANSIENT_THREAD_READ_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.ws.request<AppServerReadResponse>('thread/read', {
          threadId,
          includeTurns,
        });
      } catch (error) {
        if (!isTransientThreadReadError(error)) {
          throw error;
        }
        lastTransientError = error;
        const retryDelayMs = TRANSIENT_THREAD_READ_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw error;
        }
        await sleep(retryDelayMs);
      }
    }
    throw lastTransientError;
  }
  protected async getChatWithUserMessage(
    id: string,
    turnId: string,
    content: string,
    mentions: TurnInputMention[] = [],
    localImages: TurnInputLocalImage[] = [],
  ): Promise<Chat> {
    const normalizedContent = content.trim();
    let latestSnapshot = await this.readChatSnapshot(id);
    let latest = latestSnapshot.chat;
    if (!normalizedContent) {
      return latest;
    }
    const hasMatchingTurnMessage = rawThreadHasTurnUserMessage(
      latestSnapshot.rawThread,
      turnId,
      normalizedContent,
      mentions,
      localImages,
    );
    const hasFallbackRecentMessage =
      !rawThreadHasTurns(latestSnapshot.rawThread) &&
      chatHasRecentUserMessage(latest, normalizedContent, mentions, localImages);
    if (hasMatchingTurnMessage || hasFallbackRecentMessage) {
      this.rememberChat(latest);
      return latest;
    }
    const retryDelaysMs = [25, 50, 100, 150];
    for (const delayMs of retryDelaysMs) {
      await sleep(delayMs);
      latestSnapshot = await this.readChatSnapshot(id);
      latest = latestSnapshot.chat;
      const matchedAfterRetry = rawThreadHasTurnUserMessage(
        latestSnapshot.rawThread,
        turnId,
        normalizedContent,
        mentions,
        localImages,
      );
      const matchedByFallback =
        !rawThreadHasTurns(latestSnapshot.rawThread) &&
        chatHasRecentUserMessage(latest, normalizedContent, mentions, localImages);
      if (matchedAfterRetry || matchedByFallback) {
        this.rememberChat(latest);
        return latest;
      }
    }
    const synthetic = appendSyntheticUserMessage(latest, normalizedContent, mentions, localImages);
    this.rememberChat(synthetic);
    return synthetic;
  }
}
