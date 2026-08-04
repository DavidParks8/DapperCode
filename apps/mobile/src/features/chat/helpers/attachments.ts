import type {
  Chat,
  LocalImageInput,
  MentionInput,
  ChatMessage as ChatTranscriptMessage,
} from '@bridge/types/types';
import { getMessageText } from '@bridge/messages';
import type { PendingOptimisticUserMessage } from './types';

export function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getWorkspaceBrowseCacheKey(path: string | null): string {
  return path ?? '__bridge_default__';
}

export function normalizeAttachmentPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCloneDirectoryName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return null;
  }
  if (/[\\/]/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function deriveCloneDirectoryName(url: string | null | undefined): string | null {
  if (typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }

  const lastSlash = trimmed.lastIndexOf('/');
  const lastColon = trimmed.lastIndexOf(':');
  const splitIndex = Math.max(lastSlash, lastColon);
  const candidate = (splitIndex >= 0 ? trimmed.slice(splitIndex + 1) : trimmed).replace(
    /\.git$/i,
    '',
  );

  return normalizeCloneDirectoryName(candidate);
}

export function formatGitCloneFailureMessage(
  result: {
    code: number | null;
    stdout: string;
    stderr: string;
    cloned: boolean;
  },
  fallbackLabel = 'repository',
): string | null {
  if (result.cloned && (result.code === null || result.code === 0)) {
    return null;
  }

  const detail = (result.stderr || result.stdout).trim();
  return detail.length > 0 ? detail : `Git clone failed for ${fallbackLabel}.`;
}

export function joinWorkspacePath(parentPath: string, child: string): string {
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/';
  if (parentPath.endsWith('/') || parentPath.endsWith('\\')) {
    return `${parentPath}${child}`;
  }
  return `${parentPath}${separator}${child}`;
}

export function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

export function resolveMentionPath(path: string, workspace: string | null | undefined): string {
  const normalizedPath = normalizeAttachmentPath(path);
  if (!normalizedPath) {
    return path;
  }
  if (isAbsoluteWorkspacePath(normalizedPath)) {
    return normalizedPath;
  }

  const normalizedWorkspace = normalizeWorkspacePath(workspace);
  if (!normalizedWorkspace) {
    return normalizedPath;
  }

  return joinWorkspacePath(normalizedWorkspace, normalizedPath);
}

export function toMentionInput(path: string, workspace?: string | null): MentionInput {
  const resolvedPath = resolveMentionPath(path, workspace);
  const segments = resolvedPath.split(/[\\/]/).filter(Boolean);
  const name = segments[segments.length - 1] ?? resolvedPath;
  return {
    path: resolvedPath,
    name,
  };
}

export function toOptimisticUserContent(
  content: string,
  mentions: MentionInput[],
  localImages: LocalImageInput[],
): string {
  if (mentions.length === 0 && localImages.length === 0) {
    return content;
  }

  const mentionLines = mentions.map((mention) => `[file: ${mention.path}]`);
  const localImageLines = localImages.map((image) => `[local image: ${image.path}]`);
  return [content, ...mentionLines, ...localImageLines].join('\n');
}

export function countUserMessages(messages: ChatTranscriptMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      count += 1;
    }
  }
  return count;
}

export function normalizeChatMessageMatchContent(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isSyntheticUserAttachmentLine(line))
    .join('\n')
    .trim();
}

export function isSyntheticUserAttachmentLine(value: string): boolean {
  return (
    /^\[file:\s*(.+?)\]$/i.test(value) ||
    /^\[local image:\s*(.+?)\]$/i.test(value) ||
    /^\[image:\s*(.+?)\]$/i.test(value)
  );
}

export function reconcileChatWithPendingOptimisticMessages(
  chat: Chat,
  pendingMessages: PendingOptimisticUserMessage[],
): {
  chat: Chat;
  remainingPendingMessages: PendingOptimisticUserMessage[];
} {
  if (pendingMessages.length === 0) {
    return {
      chat,
      remainingPendingMessages: [],
    };
  }

  const userMessages = chat.messages.filter((message) => message.role === 'user');
  const remainingPendingMessages = pendingMessages.filter((entry) => {
    const pendingContent = normalizeChatMessageMatchContent(getMessageText(entry.message));
    const matchedUserMessage = userMessages[entry.userOrdinal - 1];

    if (!matchedUserMessage) {
      return true;
    }

    return normalizeChatMessageMatchContent(getMessageText(matchedUserMessage)) !== pendingContent;
  });

  if (remainingPendingMessages.length === 0) {
    return {
      chat,
      remainingPendingMessages,
    };
  }

  const lastPendingMessage = remainingPendingMessages[remainingPendingMessages.length - 1]?.message;
  return {
    chat: {
      ...chat,
      lastMessagePreview:
        normalizeChatMessageMatchContent(
          lastPendingMessage ? getMessageText(lastPendingMessage) : '',
        ).slice(0, 120) || chat.lastMessagePreview,
      messages: [...chat.messages, ...remainingPendingMessages.map((entry) => entry.message)],
    },
    remainingPendingMessages,
  };
}

export function toPathBasename(path: string): string {
  const normalized = path.trim();
  if (!normalized) {
    return 'image';
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function draftContainsMentionLabel(draft: string, label: string): boolean {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return false;
  }

  const pattern = new RegExp(`(^|[^\\w])@${escapeRegex(trimmedLabel)}(?=$|[^\\w])`, 'i');
  return pattern.test(draft);
}
