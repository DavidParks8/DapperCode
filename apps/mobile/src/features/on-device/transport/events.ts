import { EventType } from '@ag-ui/core';

import { TOOL_META_EVENT_NAME } from '@bridge/toolMeta';
import type { LocalMessage, LocalThread } from '../runtime/types';
import {
  describeLocalToolMessage,
  localReasoningId,
  localRunId,
  localThreadSummary,
  localToolStatus,
  type LocalThreadProjectionContext,
} from './wire';

export interface LocalNotification {
  method: string;
  params: Record<string, unknown>;
}

interface RunTrack {
  turnId: string;
  runId: string;
  openText: Set<string>;
  openReasoning: Set<string>;
  endedTools: Set<string>;
}

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'interrupted']);

/**
 * Turns successive runtime thread states into the bridge notifications the chat shell already
 * consumes: thread lifecycle notifications for the drawer and AG-UI run events for the transcript.
 *
 * The runtime publishes state, not events, so the projector diffs each thread against the last
 * state it emitted for. Text that is not an append of what was streamed (for example a final reply
 * that differs from the streamed draft) is not re-sent; the run's terminal event makes the shell
 * reload the authoritative snapshot.
 */
export class LocalEventProjector {
  private readonly seen = new Map<string, LocalThread>();
  private readonly runs = new Map<string, RunTrack>();

  constructor(private readonly context: () => LocalThreadProjectionContext) {}

  /** Records the current state as already delivered, without emitting anything. */
  prime(threads: readonly LocalThread[]): void {
    this.seen.clear();
    this.runs.clear();
    for (const thread of threads) {
      this.seen.set(thread.id, thread);
      if (thread.status === 'running' && thread.activeTurnId) {
        this.runs.set(thread.id, this.track(thread.id, thread.activeTurnId));
      }
    }
  }

  diff(threads: readonly LocalThread[]): LocalNotification[] {
    const notifications: LocalNotification[] = [];
    const current = new Set<string>();
    for (const thread of threads) {
      current.add(thread.id);
      const previous = this.seen.get(thread.id);
      if (previous !== thread) {
        this.diffThread(previous, thread, notifications);
        this.seen.set(thread.id, thread);
      }
    }
    for (const id of [...this.seen.keys()]) {
      if (!current.has(id)) {
        this.seen.delete(id);
        this.runs.delete(id);
        notifications.push({ method: 'thread/deleted', params: { threadId: id } });
      }
    }
    return notifications;
  }

  private track(threadId: string, turnId: string): RunTrack {
    return {
      turnId,
      runId: localRunId(threadId, turnId),
      openText: new Set(),
      openReasoning: new Set(),
      endedTools: new Set(),
    };
  }

  private diffThread(
    previous: LocalThread | undefined,
    thread: LocalThread,
    out: LocalNotification[],
  ): void {
    if (!previous) {
      out.push({
        method: 'thread/started',
        params: { threadId: thread.id, thread: localThreadSummary(thread, this.context()) },
      });
    } else if (previous.title !== thread.title) {
      out.push({
        method: 'thread/name/updated',
        params: { threadId: thread.id, threadName: thread.title },
      });
    }
    const run = this.startRunIfNeeded(previous, thread, out);
    if (!run) {
      return;
    }
    const before = new Map((previous?.messages ?? []).map((message) => [message.id, message]));
    for (const message of thread.messages) {
      if (message.role === 'assistant') {
        this.diffAssistant(thread.id, before.get(message.id), message, run, out);
      } else if (message.role === 'tool') {
        this.diffTool(thread, before.get(message.id), message, run, out);
      }
    }
    if (thread.status !== 'running') {
      this.finish(thread, run, out);
      this.runs.delete(thread.id);
    }
  }

  /**
   * Starts tracking a run when the thread enters a new turn. A run that started and settled
   * between two observations is still reported, keyed by its submission.
   */
  private startRunIfNeeded(
    previous: LocalThread | undefined,
    thread: LocalThread,
    out: LocalNotification[],
  ): RunTrack | undefined {
    const current = this.runs.get(thread.id);
    const turnId = this.startedTurnId(previous, thread, current);
    if (!turnId) {
      return current;
    }
    if (current) {
      this.finish(thread, current, out);
    }
    const run = this.track(thread.id, turnId);
    this.runs.set(thread.id, run);
    this.emit(out, thread.id, run, {
      type: EventType.RUN_STARTED,
      threadId: thread.id,
      runId: run.runId,
    });
    return run;
  }

  private startedTurnId(
    previous: LocalThread | undefined,
    thread: LocalThread,
    current: RunTrack | undefined,
  ): string | null {
    if (thread.status === 'running') {
      return thread.activeTurnId && current?.turnId !== thread.activeTurnId
        ? thread.activeTurnId
        : null;
    }
    const submissionId = thread.lastSubmissionId;
    const missedRun =
      previous !== undefined &&
      current === undefined &&
      submissionId !== null &&
      submissionId !== previous.lastSubmissionId;
    return missedRun ? `submission-${submissionId}` : null;
  }

  private diffAssistant(
    threadId: string,
    previous: LocalMessage | undefined,
    message: LocalMessage,
    run: RunTrack,
    out: LocalNotification[],
  ): void {
    this.streamText(
      threadId,
      run,
      out,
      localReasoningId(message.id),
      previous?.reasoning ?? '',
      message.reasoning ?? '',
      'reasoning',
    );
    this.streamText(
      threadId,
      run,
      out,
      message.id,
      previous?.content ?? '',
      message.content,
      'text',
    );
  }

  private diffTool(
    thread: LocalThread,
    previous: LocalMessage | undefined,
    message: LocalMessage,
    run: RunTrack,
    out: LocalNotification[],
  ): void {
    const tool = message.tool;
    if (!tool) {
      return;
    }
    const described = describeLocalToolMessage(thread, message);
    if (!previous) {
      this.startTool(thread, tool.callId, described.title, run, out);
    }
    if (previous?.tool?.status !== tool.status) {
      this.emit(out, thread.id, run, {
        type: EventType.CUSTOM,
        name: TOOL_META_EVENT_NAME,
        value: {
          toolCallId: tool.callId,
          kind: described.kind,
          status: localToolStatus(tool.status),
          title: described.title,
          startedAtMs: Date.parse(tool.startedAt),
          ...(tool.completedAt ? { completedAtMs: Date.parse(tool.completedAt) } : {}),
        },
      });
    }
    if (TERMINAL_TOOL_STATUSES.has(tool.status) && !run.endedTools.has(tool.callId)) {
      run.endedTools.add(tool.callId);
      this.emit(out, thread.id, run, { type: EventType.TOOL_CALL_END, toolCallId: tool.callId });
      this.emit(out, thread.id, run, {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${tool.callId}::result`,
        toolCallId: tool.callId,
        role: 'tool',
        content: message.content || '{}',
      });
    }
  }

  private startTool(
    thread: LocalThread,
    toolCallId: string,
    title: string,
    run: RunTrack,
    out: LocalNotification[],
  ): void {
    this.closeOpenMessages(thread.id, run, out);
    this.emit(out, thread.id, run, {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: title,
    });
    const args = thread.messages
      .flatMap((entry) => entry.toolCalls ?? [])
      .find((call) => call.id === toolCallId)?.function.arguments;
    if (args) {
      this.emit(out, thread.id, run, { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args });
    }
  }

  private streamText(
    threadId: string,
    run: RunTrack,
    out: LocalNotification[],
    messageId: string,
    before: string,
    after: string,
    kind: 'text' | 'reasoning',
  ): void {
    if (after.length <= before.length || !after.startsWith(before)) {
      return;
    }
    const open = kind === 'text' ? run.openText : run.openReasoning;
    if (!open.has(messageId)) {
      if (kind === 'text') {
        for (const reasoning of run.openReasoning) {
          this.emit(out, threadId, run, {
            type: EventType.REASONING_MESSAGE_END,
            messageId: reasoning,
          });
        }
        run.openReasoning.clear();
      }
      open.add(messageId);
      this.emit(
        out,
        threadId,
        run,
        kind === 'text'
          ? { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
          : { type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' },
      );
    }
    this.emit(out, threadId, run, {
      type: kind === 'text' ? EventType.TEXT_MESSAGE_CONTENT : EventType.REASONING_MESSAGE_CONTENT,
      messageId,
      delta: after.slice(before.length),
    });
  }

  private closeOpenMessages(threadId: string, run: RunTrack, out: LocalNotification[]): void {
    for (const messageId of run.openReasoning) {
      this.emit(out, threadId, run, { type: EventType.REASONING_MESSAGE_END, messageId });
    }
    for (const messageId of run.openText) {
      this.emit(out, threadId, run, { type: EventType.TEXT_MESSAGE_END, messageId });
    }
    run.openReasoning.clear();
    run.openText.clear();
  }

  private finish(thread: LocalThread, run: RunTrack, out: LocalNotification[]): void {
    this.closeOpenMessages(thread.id, run, out);
    if (thread.status === 'failed' || thread.status === 'interrupted') {
      this.emit(out, thread.id, run, {
        type: EventType.RUN_ERROR,
        message:
          thread.lastError ??
          (thread.status === 'interrupted' ? 'Stopped.' : 'The local turn failed.'),
        code: thread.status === 'interrupted' ? 'interrupted' : 'on_device_run_failed',
      });
      return;
    }
    this.emit(out, thread.id, run, {
      type: EventType.RUN_FINISHED,
      threadId: thread.id,
      runId: run.runId,
    });
  }

  private emit(
    out: LocalNotification[],
    threadId: string,
    run: RunTrack,
    event: Record<string, unknown>,
  ): void {
    out.push({
      method: 'bridge/agui.event',
      params: {
        threadId,
        runId: run.runId,
        sourceTurnId: run.turnId,
        event: { ...event, timestamp: Date.now() },
      },
    });
  }
}
