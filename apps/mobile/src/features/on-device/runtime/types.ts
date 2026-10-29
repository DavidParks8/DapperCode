export interface LocalToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LocalMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  reasoning?: string;
  toolCalls?: LocalToolCall[];
  tool?: {
    callId: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
    startedAt: string;
    completedAt?: string;
  };
}

export interface LocalThread {
  version: 1;
  id: string;
  title: string;
  workspaceId: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  status: 'idle' | 'running' | 'complete' | 'interrupted' | 'failed';
  activeTurnId: string | null;
  lastSubmissionId: string | null;
  lastError: string | null;
  messages: LocalMessage[];
}
