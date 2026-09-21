import { getMessageText } from '@bridge/messages';
import type { Chat } from '@bridge/types/types';

export interface InterruptedChatCreation {
  submissionId: string;
  pendingChatId: string;
  profileId?: string;
  draft: string;
  originalDraft?: string;
  cwd: string | undefined;
  agentId: string | undefined;
  hadAttachments: boolean;
  createdChatId?: string;
}

export function isPendingChatId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith('pending-'));
}

function readPendingAgentId(chat: Chat): string | undefined {
  const metadataAgentId = chat.localPendingCreation?.agentId;
  return metadataAgentId ?? (chat.agentId && chat.agentId !== 'unknown' ? chat.agentId : undefined);
}

export function readInterruptedChatCreation(chat: Chat | null): InterruptedChatCreation | null {
  if (!chat || !isPendingChatId(chat.id)) {
    return null;
  }
  const metadata = chat.localPendingCreation;
  const legacyMessages = chat.messages
    .filter((message) => message.role === 'user')
    .map(getMessageText);
  const legacyLines = legacyMessages.flatMap((message) => message.split(/\r?\n/));
  const hadLegacyAttachments = legacyLines.some(isSyntheticAttachmentLine);
  return {
    submissionId: chat.id.slice('pending-'.length),
    pendingChatId: chat.id,
    profileId: metadata?.profileId,
    originalDraft: metadata?.originalDraft,
    draft:
      metadata?.draft ??
      legacyMessages
        .map((message) =>
          message
            .split(/\r?\n/)
            .filter((line) => !isSyntheticAttachmentLine(line))
            .join('\n')
            .trim(),
        )
        .filter(Boolean)
        .join('\n\n'),
    cwd: (metadata?.cwd ?? chat.cwd) || undefined,
    agentId: readPendingAgentId(chat),
    hadAttachments: metadata?.hadAttachments ?? hadLegacyAttachments,
    createdChatId: metadata?.createdChatId,
  };
}

function isSyntheticAttachmentLine(value: string): boolean {
  return (
    /^\[file:\s*(.+?)\]$/i.test(value.trim()) ||
    /^\[(?:local )?image:\s*(.+?)\]$/i.test(value.trim())
  );
}

export function mergeRecoveredDraft(original: string, saved: string): string {
  if (!saved.trim() || original.trim() === saved.trim() || original.endsWith(`\n\n${saved}`)) {
    return original;
  }
  if (!original.trim() || saved.startsWith(`${original}\n\n`)) {
    return saved;
  }
  return `${original}\n\n${saved}`;
}

export function interruptedCreationRetryId(
  interrupted: InterruptedChatCreation | null,
  content: string,
  mentions: readonly string[],
  localImages: readonly string[],
  sameProfile: boolean,
  agentId: string | null,
  cwd: string | null,
): string | undefined {
  const sameAgent = interrupted?.agentId !== undefined && interrupted.agentId === agentId;
  const sameWorkspace = (interrupted?.cwd ?? '') === (cwd ?? '');
  return sameProfile &&
    sameAgent &&
    sameWorkspace &&
    !interrupted?.hadAttachments &&
    interrupted?.draft.trim() === content.trim() &&
    mentions.length === 0 &&
    localImages.length === 0
    ? interrupted.submissionId
    : undefined;
}
