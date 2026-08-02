import type { AGUIEvent } from '@ag-ui/core';
import type { Chat, ChatMessage, ChatStatus } from '../api/types';
import { type AgUiEventEnvelope, updateAgUiLiveAssistantMessages } from '../api/agUi';
import type { AgUiMessageState, AgUiThreadMessageState } from '../api/agUiMessagesState';
import { projectTranscript } from '../screens/main/controllers/transcriptProjectionController';
import {
  buildTranscriptDisplayItems,
  type TranscriptDisplayItem,
} from '../screens/main/transcriptMessages';
import { getMessageText, getSubAgentMeta } from '../api/messages';

export interface EventRecord {
  threadId: string;
  runId: string;
  event: AGUIEvent;
  timestamp: number;
}

export interface TranscriptSnapshot {
  messages: ChatMessage[];
  items: TranscriptDisplayItem[];
  hiddenInheritedMessageCount: number;
}

export interface ActivityStatus {
  hasRunning: boolean;
  hasTerminal: boolean;
  threadCount: number;
}

export class TestableThreadState {
  private state: AgUiMessageState = {};
  private chats = new Map<string, Chat>();
  private threadStatuses = new Map<string, ChatStatus>();
  private eventLog: EventRecord[] = [];
  private eventCounter = 0;

  /** Apply a single AG-UI event and return the updated state snapshot. */
  apply(
    threadId: string,
    runId: string,
    event: AGUIEvent,
    timestamp?: number,
  ): AgUiThreadMessageState {
    const ts = timestamp ?? this.nextTimestamp();
    const envelope: AgUiEventEnvelope = { threadId, runId, event };
    const before = this.state[threadId];
    this.state = updateAgUiLiveAssistantMessages(this.state, envelope);
    const after = this.state[threadId];
    if (after !== before) {
      this.eventLog.push({ threadId, runId, event, timestamp: ts });
    }
    return after;
  }

  /** Apply an entire sequence of events. */
  applySequence(
    sequence: Array<{ threadId: string; runId: string; event: AGUIEvent }>,
  ): AgUiThreadMessageState | undefined {
    let last: AgUiThreadMessageState | undefined;
    for (const { threadId, runId, event } of sequence) {
      last = this.apply(threadId, runId, event);
    }
    return last;
  }

  /** Get the raw reducer state for a thread. */
  getThreadState(threadId: string): AgUiThreadMessageState | undefined {
    return this.state[threadId];
  }

  /** Get the full message state (all threads). */
  getMessageState(): AgUiMessageState {
    return this.state;
  }

  /** Register a persisted chat so projection can use it. */
  setPersistedChat(chat: Chat): void {
    this.chats.set(chat.id, chat);
  }

  /** Register a thread status for sub-agent status sync. */
  setThreadStatus(threadId: string, status: ChatStatus): void {
    this.threadStatuses.set(threadId, status);
  }

  /** Build a synthetic persisted chat from live state (useful when no persistence mock needed). */
  buildSyntheticChat(threadId: string): Chat {
    const threadState = this.state[threadId];
    const messages = threadState?.messages ?? [];
    return {
      id: threadId,
      title: '',
      status: 'idle',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      statusUpdatedAt: new Date(0).toISOString(),
      lastMessagePreview: '',
      messages,
    };
  }

  /** Project the transcript for a thread (what the UI would render). */
  projectTranscript(
    threadId: string,
    options?: { showToolCalls?: boolean; parentThreadId?: string },
  ): TranscriptSnapshot {
    const chat = this.chats.get(threadId) ?? this.buildSyntheticChat(threadId);
    const parentChat = options?.parentThreadId
      ? (this.chats.get(options.parentThreadId) ?? this.buildSyntheticChat(options.parentThreadId))
      : null;
    const projection = projectTranscript({
      chat,
      parentChat,
      showToolCalls: options?.showToolCalls ?? true,
      threadStatuses: this.threadStatuses,
      liveMessageState: this.state[threadId],
    });
    return {
      ...projection,
      items: buildTranscriptDisplayItems(projection.messages),
    };
  }

  /** Get all message IDs in projection order for a thread. */
  getMessageIds(threadId: string): string[] {
    const { messages } = this.projectTranscript(threadId);
    return messages.map((m) => m.id);
  }

  /** Get all message contents in projection order for a thread. */
  getMessageContents(threadId: string): Array<{ id: string; role: string; content: string }> {
    const { messages } = this.projectTranscript(threadId);
    return messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: getMessageText(m),
    }));
  }

  /** Check for duplicate message IDs in the projected transcript. */
  findDuplicateIds(threadId: string): string[] {
    const ids = this.getMessageIds(threadId);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    return dupes;
  }

  /** Check for duplicate message content in the projected transcript. */
  findDuplicateContent(threadId: string): Array<{ content: string; count: number }> {
    const contents = this.getMessageContents(threadId).map((m) => m.content);
    const counts = new Map<string, number>();
    for (const c of contents) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([content, count]) => ({ content, count }));
  }

  /** Get sub-agent activity messages for a parent thread. */
  getSubAgentActivities(threadId: string): ChatMessage[] {
    const { messages } = this.projectTranscript(threadId);
    return messages.filter((m) => {
      const meta = getSubAgentMeta(m);
      return meta !== undefined;
    });
  }

  /** Get sub-agent thread IDs linked to a parent thread. */
  getSubAgentThreadIds(threadId: string): string[] {
    const activities = this.getSubAgentActivities(threadId);
    const ids: string[] = [];
    for (const msg of activities) {
      const meta = getSubAgentMeta(msg);
      if (meta?.receiverThreadIds) {
        ids.push(...meta.receiverThreadIds);
      }
    }
    return ids;
  }

  /** Get the count of running sub-agents for a parent thread. */
  getRunningSubAgentCount(threadId: string): number {
    const activities = this.getSubAgentActivities(threadId);
    return activities.filter((m) => {
      const meta = getSubAgentMeta(m);
      return meta?.agentStatus === 'running';
    }).length;
  }

  /** Derive the aggregate activity status for a thread based on reducer state. */
  getActivityStatus(threadId: string): ActivityStatus {
    const threadState = this.state[threadId];
    if (!threadState) {
      return { hasRunning: false, hasTerminal: false, threadCount: 0 };
    }
    const steps = Object.values(threadState.steps);
    const hasRunning = steps.some((s) => s === 'running');
    const hasTerminal = threadState.terminalMessageIds.length > 0;
    return {
      hasRunning,
      hasTerminal,
      threadCount: threadState.messages.length,
    };
  }

  /** Get the event log (all applied events). */
  getEventLog(): readonly EventRecord[] {
    return this.eventLog;
  }

  /** Get the number of events applied. */
  getEventCount(): number {
    return this.eventLog.length;
  }

  private nextTimestamp(): number {
    return 1_000_000_000_000 + this.eventCounter++;
  }
}
