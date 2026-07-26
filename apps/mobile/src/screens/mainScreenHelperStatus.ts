import type {
  Chat,
  ChatSummary,
  PendingApproval,
  ChatMessage as ChatTranscriptMessage,
} from '../api/types';
import { getMessageText } from '../api/messages';
import { readString, readStringArray, toRecord } from './mainScreenHelperPayloads';
import { stripMarkdownInline, toTickerSnippet } from './mainScreenHelperTimeline';
import {
  LIKELY_RUNNING_RECENT_UPDATE_MS,
  UNANSWERED_USER_RUNNING_TTL_MS,
  type ActivityState,
} from './mainScreenHelperTypes';

export function normalizeExternalStatusHint(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function extractNotificationThreadId(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null
): string | null {
  if (!params && !msgArg) {
    return null;
  }

  const msg = msgArg ?? toRecord(params?.msg);
  const threadRecord =
    toRecord(params?.thread) ??
    toRecord(params?.threadState) ??
    toRecord(params?.thread_state) ??
    toRecord(msg?.thread);
  const threadSourceRecord = toRecord(threadRecord?.source);
  const turnRecord = toRecord(params?.turn) ?? toRecord(msg?.turn);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent ?? sourceRecord?.subAgent)?.thread_spawn
  );
  const threadSubagentThreadSpawnRecord = toRecord(
    toRecord(threadSourceRecord?.subagent ?? threadSourceRecord?.subAgent)?.thread_spawn
  );

  return (
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(msg?.conversation_id) ??
    readString(msg?.conversationId) ??
    readString(params?.thread_id) ??
    readString(params?.threadId) ??
    readString(params?.conversation_id) ??
    readString(params?.conversationId) ??
    readString(threadRecord?.id) ??
    readString(threadRecord?.thread_id) ??
    readString(threadRecord?.threadId) ??
    readString(threadRecord?.conversation_id) ??
    readString(threadRecord?.conversationId) ??
    readString(turnRecord?.thread_id) ??
    readString(turnRecord?.threadId) ??
    readString(sourceRecord?.thread_id) ??
    readString(sourceRecord?.threadId) ??
    readString(sourceRecord?.conversation_id) ??
    readString(sourceRecord?.conversationId) ??
    readString(sourceRecord?.parent_thread_id) ??
    readString(sourceRecord?.parentThreadId) ??
    readString(subagentThreadSpawnRecord?.parent_thread_id) ??
    readString(subagentThreadSpawnRecord?.parentThreadId) ??
    readString(threadSourceRecord?.parent_thread_id) ??
    readString(threadSourceRecord?.parentThreadId) ??
    readString(threadSubagentThreadSpawnRecord?.parent_thread_id) ??
    readString(threadSubagentThreadSpawnRecord?.parentThreadId) ??
    null
  );
}

export function extractNotificationParentThreadId(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null
): string | null {
  if (!params && !msgArg) {
    return null;
  }

  const msg = msgArg ?? toRecord(params?.msg);
  const threadRecord =
    toRecord(params?.thread) ??
    toRecord(params?.threadState) ??
    toRecord(params?.thread_state) ??
    toRecord(msg?.thread);
  const threadSourceRecord = toRecord(threadRecord?.source);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent ?? sourceRecord?.subAgent)?.thread_spawn
  );
  const threadSubagentThreadSpawnRecord = toRecord(
    toRecord(threadSourceRecord?.subagent ?? threadSourceRecord?.subAgent)?.thread_spawn
  );

  return (
    readString(sourceRecord?.parent_thread_id) ??
    readString(sourceRecord?.parentThreadId) ??
    readString(subagentThreadSpawnRecord?.parent_thread_id) ??
    readString(subagentThreadSpawnRecord?.parentThreadId) ??
    readString(threadSourceRecord?.parent_thread_id) ??
    readString(threadSourceRecord?.parentThreadId) ??
    readString(threadSubagentThreadSpawnRecord?.parent_thread_id) ??
    readString(threadSubagentThreadSpawnRecord?.parentThreadId) ??
    null
  );
}

export function extractExternalStatusHint(
  params: Record<string, unknown> | null
): string | null {
  if (!params) {
    return null;
  }

  const directCandidates: unknown[] = [
    params.status,
    params.threadStatus,
    params.thread_status,
    params.state,
    params.phase,
  ];
  for (const candidate of directCandidates) {
    const direct = normalizeExternalStatusHint(readString(candidate));
    if (direct) {
      return direct;
    }

    const candidateRecord = toRecord(candidate);
    const typed = normalizeExternalStatusHint(
      readString(candidateRecord?.type) ??
        readString(candidateRecord?.status) ??
        readString(candidateRecord?.state) ??
        readString(candidateRecord?.phase)
    );
    if (typed) {
      return typed;
    }
  }

  const threadRecord =
    toRecord(params.thread) ?? toRecord(params.threadState) ?? toRecord(params.thread_state);
  if (!threadRecord) {
    return null;
  }

  const nestedThreadStatus = normalizeExternalStatusHint(
    readString(threadRecord.status) ??
      readString(toRecord(threadRecord.status)?.type) ??
      readString(threadRecord.state) ??
      readString(threadRecord.phase) ??
      readString(toRecord(threadRecord.lifecycle)?.status)
  );
  return nestedThreadStatus;
}

export function isChatSummaryLikelyRunning(chat: ChatSummary): boolean {
  return chat.status === 'running';
}

/**
 * A thread is working whenever it, or any sub-agent beneath it, is working.
 *
 * A parent's own run can settle to `complete` while a sub-agent it spawned is still
 * streaming. Reporting "Ready" then contradicts the sub-agent card spinning in the
 * same transcript, and makes the composer look safe to use when it is not.
 *
 * Only descendants of `chat` count. `relatedAgentThreads` holds every thread in the root's
 * tree — the selected thread's ancestors and siblings included — and it is refreshed
 * asynchronously, so after switching chats it still describes the thread the user just left.
 * Accepting any parented thread let one chat's live sub-agent pin an unrelated, finished chat
 * to "Working" the moment it was opened second.
 */
export function isThreadOrSubAgentRunning(
  chat: Chat | null,
  relatedAgentThreads: readonly ChatSummary[]
): boolean {
  if (chat && isChatLikelyRunning(chat)) {
    return true;
  }

  if (!chat) {
    return false;
  }

  return descendantsOf(chat.id, relatedAgentThreads).some(isChatSummaryLikelyRunning);
}

function descendantsOf(
  threadId: string,
  relatedAgentThreads: readonly ChatSummary[]
): ChatSummary[] {
  const byParent = new Map<string, ChatSummary[]>();
  for (const thread of relatedAgentThreads) {
    const parentThreadId = thread.parentThreadId;
    if (!parentThreadId || thread.id === threadId) {
      continue;
    }
    const siblings = byParent.get(parentThreadId);
    if (siblings) {
      siblings.push(thread);
    } else {
      byParent.set(parentThreadId, [thread]);
    }
  }

  const descendants: ChatSummary[] = [];
  const seen = new Set<string>([threadId]);
  const queue = [threadId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child.id)) {
        continue;
      }
      seen.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

export function isChatLikelyRunning(chat: Chat): boolean {
  if (chat.status === 'running') {
    return true;
  }

  // Trust definitive server statuses — don't second-guess them with heuristics.
  if (chat.status === 'error' || chat.status === 'complete' || chat.status === 'idle') {
    return false;
  }

  const lastMessage = chat.messages[chat.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return false;
  }

  // Anchored to when the prompt was written, not to `chat.updatedAt`. A reload rewrites
  // `updatedAt` — replaying a thread after the bridge restarts stamps it with the moment of
  // the replay — so an unanswered prompt from days ago looked like it had just been sent and
  // every such thread reopened as "Working" and never settled.
  const promptSentAtMs = Date.parse(lastMessage.createdAt);
  if (!Number.isFinite(promptSentAtMs)) {
    return false;
  }

  return Date.now() - promptSentAtMs < LIKELY_RUNNING_RECENT_UPDATE_MS;
}

export function hasRecentUnansweredUserTurn(chat: Chat): boolean {
  let lastUserIndex = -1;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    if (chat.messages[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex < 0) {
    return false;
  }

  for (let index = lastUserIndex + 1; index < chat.messages.length; index += 1) {
    if (chat.messages[index].role === 'assistant') {
      return false;
    }
  }

  const lastUser = chat.messages[lastUserIndex];
  const userCreatedAtMs = Date.parse(lastUser.createdAt);
  if (!Number.isFinite(userCreatedAtMs)) {
    return false;
  }

  return Date.now() - userCreatedAtMs < UNANSWERED_USER_RUNNING_TTL_MS;
}

export function didAssistantMessageProgress(previous: Chat | null, next: Chat): boolean {
  if (!previous || previous.id !== next.id) {
    return false;
  }

  // An empty previous transcript is not a baseline, it is the placeholder shown between
  // tapping a session and its history arriving. Treating the jump from nothing to a full
  // replayed transcript as progress armed the run watchdog on every open, so a session that
  // finished days ago announced itself as working for as long as the watchdog ran.
  if (previous.messages.length === 0) {
    return false;
  }

  const previousLatestAssistant = latestAssistantMessage(previous.messages);
  const nextLatestAssistant = latestAssistantMessage(next.messages);

  if (!nextLatestAssistant) {
    return false;
  }

  if (!previousLatestAssistant) {
    return getMessageText(nextLatestAssistant).trim().length > 0;
  }

  if (nextLatestAssistant.id === previousLatestAssistant.id) {
    return getMessageText(nextLatestAssistant).length > getMessageText(previousLatestAssistant).length;
  }

  return (
    next.messages.length > previous.messages.length &&
    getMessageText(nextLatestAssistant).trim().length > 0
  );
}

export function latestAssistantMessage(messages: ChatTranscriptMessage[]): ChatTranscriptMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return message;
    }
  }
  return null;
}

export function extractFirstBoldSnippet(
  value: string | null | undefined,
  maxLength = 56
): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/\*\*([^*]+)\*\*/);
  if (!match) {
    return null;
  }

  return toTickerSnippet(match[1], maxLength);
}

export function toReasoningActivityDetail(
  value: string | null | undefined,
  heading: string | null | undefined,
  maxLength = 64
): string | undefined {
  if (!value) {
    return undefined;
  }

  let cleaned = stripMarkdownInline(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return undefined;
  }

  if (heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned
      .replace(new RegExp(`^${escapedHeading}(?:\\s*[:\\-.–—]\\s*|\\s+)`, 'i'), '')
      .trim();
    if (!cleaned || cleaned.toLowerCase() === heading.toLowerCase()) {
      return undefined;
    }
  }

  return toTickerSnippet(cleaned, maxLength) ?? undefined;
}

export function toPendingApproval(value: unknown): PendingApproval | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const requestId = readString(record.requestId) ?? readString(record.id);
  const kind = readString(record.kind);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const requestedAt = readString(record.requestedAt);

  if (
    !requestId ||
    !kind ||
    !threadId ||
    !turnId ||
    !itemId ||
    !requestedAt ||
    (kind !== 'commandExecution' && kind !== 'fileChange')
  ) {
    return null;
  }

  return {
    requestId,
    agentId: readString(record.agentId) ?? '',
    kind,
    threadId,
    turnId,
    itemId,
    title: readString(record.title) ?? readString(record.reason) ?? '',
    message: readString(record.message) ?? readString(record.reason) ?? '',
    requestedAt,
    reason: readString(record.reason) ?? undefined,
    command: readString(record.command) ?? undefined,
    cwd: readString(record.cwd) ?? undefined,
    grantRoot: readString(record.grantRoot) ?? undefined,
    proposedExecpolicyAmendment: readStringArray(record.proposedExecpolicyAmendment) ?? undefined,
    options: Array.isArray(record.options)
      ? record.options.flatMap((value) => {
          const option = toRecord(value);
          const optionId = readString(option?.id);
          const label = readString(option?.label) ?? readString(option?.name);
          const optionKind = readString(option?.kind);
          return optionId && label ? [{ id: optionId, label, kind: optionKind ?? undefined }] : [];
        })
      : [],
  };
}

/**
 * The header state written while a chat is being opened, before there is a transcript.
 *
 * It is a placeholder, not a report about the thread, so anything that finishes a load has to
 * retire it.
 */
export const OPENING_CHAT_ACTIVITY_TITLE = 'Opening chat';

/**
 * The header state a thread that is not running should settle on.
 */
export function resolveSettledActivity(chat: Chat): ActivityState {
  if (chat.status === 'complete') {
    return { tone: 'complete', title: 'Turn completed' };
  }
  if (chat.status === 'error') {
    return {
      tone: 'error',
      title: 'Turn failed',
      detail: chat.lastError ?? undefined,
    };
  }
  return { tone: 'idle', title: 'Ready' };
}

/**
 * Retires the "Opening chat" placeholder once a load has produced a transcript.
 *
 * A load that is superseded while opening a chat returns before it can report the thread's
 * status, and the revalidation that replaced it preserves runtime state and so deliberately
 * leaves the header alone. Between them the placeholder was never retired, and because it is
 * a running state the header rendered "Working" on a finished thread until something else
 * happened to write it. Nothing else reports on a thread that is not running, so it never did.
 */
export function retireOpeningChatActivity(
  current: ActivityState,
  chat: Chat
): ActivityState {
  if (current.tone !== 'running' || current.title !== OPENING_CHAT_ACTIVITY_TITLE) {
    return current;
  }
  return resolveSettledActivity(chat);
}
