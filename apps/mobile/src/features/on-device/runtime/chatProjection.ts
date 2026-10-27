import type { Chat, ChatMessage, ChatToolKind } from '@bridge/types/types';
import type { LocalMessage, LocalThread } from './types';

function toolKind(name: string): ChatToolKind {
  if (name === 'write_file' || name === 'edit_file') {
    return 'edit';
  }
  if (name === 'delete_path') {
    return 'delete';
  }
  if (name === 'rename_path') {
    return 'move';
  }
  if (name === 'search_files') {
    return 'search';
  }
  if (['read_file', 'list_directory', 'git_status', 'git_diff', 'git_history'].includes(name)) {
    return 'read';
  }
  return 'other';
}

function messageProjection(message: LocalMessage, pending: boolean): ChatMessage {
  const base = { id: message.id, createdAt: message.createdAt, content: message.content };
  switch (message.role) {
    case 'user':
      return { ...base, role: 'user' };
    case 'assistant':
      return {
        ...base,
        role: 'assistant',
        pending,
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      };
    case 'tool': {
      if (!message.tool) {
        throw new Error('The local tool result is missing its invocation.');
      }
      const tool = message.tool;
      return {
        ...base,
        role: 'tool',
        toolCallId: tool.callId,
        toolMeta: {
          toolCallId: tool.callId,
          kind: toolKind(tool.name),
          status:
            tool.status === 'running'
              ? 'in_progress'
              : tool.status === 'interrupted'
                ? 'failed'
                : tool.status,
          title:
            tool.status === 'interrupted'
              ? `${tool.name} - interrupted, inspect changes`
              : tool.name,
          startedAtMs: Date.parse(tool.startedAt),
          ...(tool.completedAt ? { completedAtMs: Date.parse(tool.completedAt) } : {}),
        },
      };
    }
  }
}

export function localChatProjection(thread: LocalThread, workspaceName: string): Chat {
  return {
    id: thread.id,
    title: thread.title,
    agentId: 'on-device',
    status:
      thread.status === 'running'
        ? 'running'
        : thread.status === 'complete'
          ? 'complete'
          : thread.status === 'failed'
            ? 'error'
            : 'idle',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    statusUpdatedAt: thread.updatedAt,
    lastMessagePreview: thread.messages.at(-1)?.content.slice(0, 120) ?? '',
    cwd: workspaceName,
    modelProvider: 'On this iPhone',
    sourceKind: 'on-device',
    activeTurnId: thread.activeTurnId,
    latestTurnStatus: thread.status,
    ...(thread.lastError ? { lastError: thread.lastError } : {}),
    messages: thread.messages.map((message, index) =>
      messageProjection(
        message,
        thread.status === 'running' && index === thread.messages.length - 1,
      ),
    ),
  };
}
