import type { AgUiThreadMessageState } from '@bridge/agui/agUiMessages';
import { partsMatchMessageContent } from '@bridge/agui/agUiContent';
import { isLocalTranscriptMessage } from '@bridge/mapping/chatReconciliation';
import { getMessageText, isTransientUserMessage } from '@bridge/messages';
import type { Chat, ChatMessage } from '@bridge/types/types';

type SnapshotRunRelation = 'older' | 'current' | 'unknown';
interface SnapshotMatch {
  index: number;
  message: ChatMessage;
  previous: ChatMessage;
}
interface SnapshotProjection {
  messages: ChatMessage[];
  aliases: ReadonlyMap<string, string>;
}

export function getSnapshotRunRelation(
  state: AgUiThreadMessageState | null | undefined,
  chat: Chat,
): SnapshotRunRelation {
  if (!state?.snapshotMessageIds) {
    return 'unknown';
  }
  const snapshotRunId = state.snapshotMessageIds
    .map((id) => state.runByMessageId[id])
    .find((runId) => runId !== undefined);
  if (!snapshotRunId) {
    return 'unknown';
  }
  if (
    state.messages.some((message) => {
      const runId = state.runByMessageId[message.id];
      return runId && runId !== snapshotRunId;
    })
  ) {
    return 'older';
  }
  const activeRunId = chat.acpSnapshot?.active.runId;
  if (!activeRunId) {
    return hasNewerCanonicalPrompt(state, chat) ? 'older' : 'unknown';
  }
  return activeRunId === snapshotRunId ? 'current' : 'older';
}

function hasNewerCanonicalPrompt(state: AgUiThreadMessageState, chat: Chat): boolean {
  const pending = chat.messages.at(-1);
  return (
    chat.status === 'running' &&
    pending?.role === 'user' &&
    !isTransientUserMessage(pending) &&
    !isLocalTranscriptMessage(pending) &&
    !state.snapshotMessageIds?.includes(pending.id) &&
    state.messages.some(
      (message) => message.role === 'user' && state.snapshotMessageIds?.includes(message.id),
    )
  );
}

export function carriesToolActivity(message: ChatMessage): boolean {
  return Boolean(message.toolMeta || (message.role === 'assistant' && message.toolCalls?.length));
}

export function applyAuthoritativeSnapshot(
  messages: ChatMessage[],
  liveMessages: ChatMessage[],
  replacedMessageIds: ReadonlySet<string>,
  now: () => string,
  relation: SnapshotRunRelation,
  snapshotWindowTruncated: boolean,
): SnapshotProjection {
  const persistedById = new Map(messages.map((message) => [message.id, message]));
  const aliases = resolveAnchoredAliases(messages, liveMessages);
  const projected = liveMessages
    .filter(
      (message) =>
        !replacedMessageIds.has(message.id) &&
        Boolean(getMessageText(message).trim() || carriesToolActivity(message)),
    )
    .map((message) => {
      const id = aliases.get(message.id) ?? message.id;
      return { ...projectMessage(message, persistedById.get(id), now), id };
    });
  const liveIds = new Set(liveMessages.map((message) => aliases.get(message.id) ?? message.id));
  if (liveMessages.length > 0 && projected.length === 0) {
    return {
      messages: messages.filter(
        (message) => !liveIds.has(message.id) && !replacedMessageIds.has(message.id),
      ),
      aliases,
    };
  }
  const firstCovered = messages.findIndex((message) => liveIds.has(message.id));
  const lastCovered = messages.reduce(
    (last, message, index) => (liveIds.has(message.id) ? index : last),
    -1,
  );
  if (lastCovered < 0 && projected.length > 0 && messages.length > 0) {
    return mergeUnanchoredSnapshot(messages, projected, relation, snapshotWindowTruncated, now);
  }
  const leading =
    firstCovered < 0
      ? []
      : messages.slice(0, firstCovered).filter((message) => !replacedMessageIds.has(message.id));
  const trailing =
    lastCovered < 0
      ? []
      : messages.slice(lastCovered + 1).filter((message) => !liveIds.has(message.id));
  const covered = preserveLocalRows(
    messages.slice(Math.max(0, firstCovered), lastCovered + 1),
    projected,
    replacedMessageIds,
  );
  return { messages: [...leading, ...covered, ...trailing], aliases };
}

function resolveAnchoredAliases(
  messages: ChatMessage[],
  snapshot: ChatMessage[],
): ReadonlyMap<string, string> {
  const indexes = new Map(messages.map((message, index) => [message.id, index]));
  const anchors = snapshot.flatMap((message, index) => {
    const previousIndex = indexes.get(message.id);
    return previousIndex === undefined ? [] : [{ index, previousIndex }];
  });
  const aliases = new Map<string, string>();
  if (anchors.length === 0) {
    return aliases;
  }
  let previousIndex = -1;
  for (const anchor of anchors) {
    if (anchor.previousIndex <= previousIndex) {
      return aliases;
    }
    previousIndex = anchor.previousIndex;
  }
  let previousStart = 0;
  let snapshotStart = 0;
  for (const anchor of [...anchors, { index: snapshot.length, previousIndex: messages.length }]) {
    if (previousStart < anchor.previousIndex && snapshotStart < anchor.index) {
      const previous = messages.slice(previousStart, anchor.previousIndex);
      const segment = snapshot.slice(snapshotStart, anchor.index);
      for (const match of matchAnchoredSegment(previous, segment, previousStart === 0)) {
        aliases.set(match.message.id, match.previous.id);
      }
    }
    previousStart = anchor.previousIndex + 1;
    snapshotStart = anchor.index + 1;
  }
  return aliases;
}

function matchAnchoredSegment(
  messages: ChatMessage[],
  snapshot: ChatMessage[],
  leading: boolean,
): SnapshotMatch[] {
  const signatures = messages.map(buildTranscriptSignature);
  const snapshotSignatures = snapshot.map(buildTranscriptSignature);
  const lastServerIndex = messages.reduce(
    (last, message, index) => (isClientOnlyGap(message) ? last : index),
    -1,
  );
  let best: SnapshotMatch[] = [];
  for (let start = 0; start < messages.length; start += 1) {
    if (!leading && start > 0 && !isClientOnlyGap(messages[start - 1])) {
      break;
    }
    const candidate = matchSnapshotAt(messages, snapshot, signatures, snapshotSignatures, start);
    const reachesEnd = candidate.cursor > lastServerIndex;
    if (
      candidate.matches.length > best.length &&
      (reachesEnd || (!leading && candidate.matches.length === snapshot.length))
    ) {
      best = candidate.matches;
    }
  }
  return best;
}

function projectMessage(
  message: ChatMessage,
  persisted: ChatMessage | undefined,
  now: () => string,
): ChatMessage {
  const parts = persisted?.parts ?? message.parts;
  return {
    ...message,
    createdAt: persisted?.createdAt || message.createdAt || now(),
    completedAt: message.completedAt ?? persisted?.completedAt,
    // Live events do not carry usage; keep it even when replay changes the message ID.
    usage: message.usage ?? persisted?.usage ?? null,
    parts: partsMatchMessageContent(parts, message.content) ? parts : undefined,
  };
}

function preserveLocalRows(
  previous: ChatMessage[],
  projected: ChatMessage[],
  replacedMessageIds: ReadonlySet<string>,
): ChatMessage[] {
  const messages = [...projected];
  let insertionIndex = messages.length;
  for (const message of [...previous].reverse()) {
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) {
      insertionIndex = index;
    } else if (isLocalTranscriptMessage(message) && !replacedMessageIds.has(message.id)) {
      messages.splice(insertionIndex, 0, message);
    }
  }
  return messages;
}

function mergeUnanchoredSnapshot(
  messages: ChatMessage[],
  projected: ChatMessage[],
  relation: SnapshotRunRelation,
  snapshotWindowTruncated: boolean,
  now: () => string,
): SnapshotProjection {
  const signatures = messages.map(buildTranscriptSignature);
  const snapshotSignatures = projected.map(buildTranscriptSignature);
  const historical =
    relation === 'older' || (relation === 'unknown' && precedesPendingUser(messages, projected));
  const minimumHistoryMatch =
    relation === 'older' && snapshotWindowTruncated && projected[0]?.role !== 'user' ? 1 : 2;
  const lastServerIndex = messages.reduce(
    (last, message, index) => (isClientOnlyGap(message) ? last : index),
    -1,
  );
  let matched: SnapshotMatch[] = [];
  for (let start = 0; start < messages.length; start += 1) {
    const candidate = matchSnapshotAt(messages, projected, signatures, snapshotSignatures, start);
    const completeHistory =
      historical &&
      candidate.matches.length >= minimumHistoryMatch &&
      candidate.matches.length === projected.length;
    if (
      candidate.matches.length > matched.length &&
      (candidate.cursor > lastServerIndex || completeHistory)
    ) {
      matched = candidate.matches;
    }
  }
  const replacements = new Map(
    matched.map(({ index, message, previous }) => [
      index,
      { ...projectMessage(message, previous, now), id: previous.id },
    ]),
  );
  return {
    messages: [
      ...messages.map((message, index) => replacements.get(index) ?? message),
      ...projected.slice(matched.length),
    ],
    aliases: new Map(matched.map(({ message, previous }) => [message.id, previous.id])),
  };
}

function precedesPendingUser(messages: ChatMessage[], snapshot: ChatMessage[]): boolean {
  const pendingUser = messages.at(-1);
  return (
    pendingUser?.role === 'user' &&
    !isLocalTranscriptMessage(pendingUser) &&
    !snapshot.some(
      (message) =>
        message.role === 'user' &&
        buildTranscriptSignature(message) === buildTranscriptSignature(pendingUser),
    )
  );
}

function matchSnapshotAt(
  messages: ChatMessage[],
  projected: ChatMessage[],
  signatures: string[],
  snapshotSignatures: string[],
  start: number,
): { matches: SnapshotMatch[]; cursor: number } {
  const matches: SnapshotMatch[] = [];
  let cursor = start;
  for (const [index, message] of projected.entries()) {
    // Client-only rows have no server counterpart and must keep their relative position.
    while (
      cursor < messages.length &&
      matches.length > 0 &&
      signatures[cursor] !== snapshotSignatures[index] &&
      isClientOnlyGap(messages[cursor])
    ) {
      cursor += 1;
    }
    const previous = messages[cursor];
    if (!previous || signatures[cursor] !== snapshotSignatures[index]) {
      break;
    }
    matches.push({ index: cursor, message, previous });
    cursor += 1;
  }
  return { matches, cursor };
}

function isClientOnlyGap(message: ChatMessage | undefined): boolean {
  return (
    isLocalTranscriptMessage(message) ||
    Boolean(message?.role === 'reasoning' && message.id.startsWith('local-reasoning-'))
  );
}

function buildTranscriptSignature(message: ChatMessage): string {
  if (
    (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'reasoning') ||
    message.toolMeta ||
    (message.role === 'assistant' && message.toolCalls?.length)
  ) {
    return `${message.role}\u0000${message.id}`;
  }
  return `${message.role}\u0000${getMessageText(message).trim()}`;
}
