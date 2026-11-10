import { EventType } from '@ag-ui/core';

import { AGENT_COMMANDS_EVENT_NAME } from '@bridge/agentCommands';
import { RUN_ACTIVITY_EVENT_NAME, type RunActivity } from '@bridge/runActivity';
import { TOOL_META_EVENT_NAME } from '@bridge/toolMeta';
import { SUBAGENT_ACTIVITY_TYPE } from '@bridge/messages';
import { childActivity } from './children';
import { WORKSPACE_HOST_NOTIFICATIONS } from '../../workspace/api/protocol';
import type { LocalRunSnapshot } from '../runtime/agentLoop';
import type { LocalMessage, LocalThread, LocalToolCall } from '../runtime/types';
import type { LocalSkillCommand } from '../runtime/skills';
import type { LocalAgentPort } from './port';
import {
  describeLocalToolMessage,
  localReasoningId,
  localRunId,
  localThreadPath,
  localThreadSummary,
  localToolCalls,
  localWorkspacePaths,
  localToolStatus,
  type LocalThreadProjectionContext,
} from './wire';

export interface LocalNotification {
  method: string;
  params: Record<string, unknown>;
}

/** Forwards native Git transfer progress as host notifications; returns the unsubscribe. */
export function forwardLocalCloneProgress(
  port: LocalAgentPort,
  publish: (notification: LocalNotification) => void,
): () => void {
  return port.workspaceAdmin.onCloneProgress((progress) => {
    publish({ method: WORKSPACE_HOST_NOTIFICATIONS.cloneProgress, params: { ...progress } });
  });
}

interface RunTrack {
  turnId: string;
  runId: string;
  openText: Set<string>;
  openReasoning: Set<string>;
  endedTools: Set<string>;
  /** The last activity sent, as `title|detail`, so unchanged phases are not re-sent. */
  activity: string | null;
}

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'interrupted']);

function sameContent(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
  /** The most recent turn tracked per thread, so a settled turn never reports loading again. */
  private readonly lastTurn = new Map<string, string>();
  /** The last loading activity sent for a run that has not started yet. */
  private loading: string | null = null;
  /** The workspace path last presented per thread, so a rename reaches open chats. */
  private readonly cwds = new Map<string, string>();
  /** The skill commands last sent per opened chat, so a changed list reaches it live. */
  private readonly commands = new Map<string, readonly LocalSkillCommand[]>();

  constructor(
    private readonly context: () => LocalThreadProjectionContext,
    private readonly activity: (thread: LocalThread) => RunActivity | null = () => null,
    private readonly run: () => Pick<LocalRunSnapshot, 'phase' | 'threadId' | 'turnId'> = () => ({
      phase: 'idle',
      threadId: null,
      turnId: null,
    }),
  ) {}

  /** Records the current state as already delivered, without emitting anything. */
  prime(threads: readonly LocalThread[]): void {
    this.seen.clear();
    this.runs.clear();
    this.lastTurn.clear();
    this.loading = null;
    this.cwds.clear();
    this.commands.clear();
    const { workspaces } = this.context();
    const paths = localWorkspacePaths(workspaces);
    for (const thread of threads) {
      this.seen.set(thread.id, thread);
      this.cwds.set(thread.id, localThreadPath(thread, workspaces, paths));
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
    this.diffCwds(threads, notifications);
    this.diffCommands(threads, notifications);
    this.diffLoadingActivity(threads, notifications);
    for (const thread of threads) {
      const run = this.runs.get(thread.id);
      if (run) {
        this.diffActivity(thread, run, notifications);
      }
    }
    for (const id of [...this.seen.keys()]) {
      if (!current.has(id)) {
        this.seen.delete(id);
        this.runs.delete(id);
        this.lastTurn.delete(id);
        this.cwds.delete(id);
        this.commands.delete(id);
        notifications.push({ method: 'thread/deleted', params: { threadId: id } });
      }
    }
    return notifications;
  }

  /**
   * A chat's presented path changes when its own workspace is renamed or removed (or an empty chat
   * moves). Open chats only hold that path, so the new one is pushed to them.
   */
  private diffCwds(threads: readonly LocalThread[], out: LocalNotification[]): void {
    const { workspaces } = this.context();
    const paths = localWorkspacePaths(workspaces);
    for (const thread of threads) {
      const cwd = localThreadPath(thread, workspaces, paths);
      const previous = this.cwds.get(thread.id);
      this.cwds.set(thread.id, cwd);
      if (previous !== undefined && previous !== cwd) {
        out.push({
          method: WORKSPACE_HOST_NOTIFICATIONS.threadCwdChanged,
          params: { threadId: thread.id, cwd },
        });
      }
    }
  }

  /**
   * A chat was opened or created: sends its workspace's skill commands now (refreshing them in the
   * background) and again whenever that cached list changes.
   */
  openCommands(thread: LocalThread): LocalNotification {
    const commands = this.context().commands(thread.workspaceId, true);
    this.commands.set(thread.id, commands);
    return this.commandsEvent(thread, commands);
  }

  private diffCommands(threads: readonly LocalThread[], out: LocalNotification[]): void {
    const read = this.context().commands;
    for (const thread of threads) {
      const sent = this.commands.get(thread.id);
      const commands = sent && read(thread.workspaceId);
      if (commands && commands !== sent && JSON.stringify(commands) !== JSON.stringify(sent)) {
        this.commands.set(thread.id, commands);
        out.push(this.commandsEvent(thread, commands));
      }
    }
  }

  private commandsEvent(
    thread: LocalThread,
    commands: readonly LocalSkillCommand[],
  ): LocalNotification {
    const turnId =
      this.runs.get(thread.id)?.turnId ?? thread.activeTurnId ?? `commands-${thread.id}`;
    return {
      method: 'bridge/agui.event',
      params: {
        threadId: thread.id,
        runId: localRunId(thread.id, turnId),
        sourceTurnId: turnId,
        event: {
          type: EventType.CUSTOM,
          name: AGENT_COMMANDS_EVENT_NAME,
          value: { commands },
          timestamp: Date.now(),
        },
      },
    };
  }

  private track(threadId: string, turnId: string): RunTrack {
    this.lastTurn.set(threadId, turnId);
    return {
      turnId,
      runId: localRunId(threadId, turnId),
      openText: new Set(),
      openReasoning: new Set(),
      endedTools: new Set(),
      activity: null,
    };
  }

  private diffThread(
    previous: LocalThread | undefined,
    thread: LocalThread,
    out: LocalNotification[],
  ): void {
    if (previous?.tasks !== thread.tasks && thread.tasks) {
      out.push({
        method: 'turn/plan/updated',
        params: {
          threadId: thread.id,
          turnId: thread.activeTurnId ?? `tasks-${thread.id}`,
          explanation: 'Conversation tasks',
          plan: thread.tasks.map((task) => ({ step: task.content, status: task.status })),
        },
      });
    }
    this.diffIdentity(previous, thread, out);
    const run = this.startRunIfNeeded(previous, thread, out);
    if (!run) {
      return;
    }
    const before = new Map((previous?.messages ?? []).map((message) => [message.id, message]));
    let calls: ReadonlyMap<string, LocalToolCall> | undefined;
    const toolCalls = () => (calls ??= localToolCalls(thread));
    for (const message of thread.messages) {
      const prior = before.get(message.id);
      if (message.role === 'assistant') {
        // Runtime messages are replaced, never mutated, so an identical one has nothing new.
        if (prior !== message) {
          this.diffAssistant(thread.id, prior, message, run, out);
        }
      } else if (message.role === 'tool') {
        this.diffTool(thread, prior, message, run, out, toolCalls);
      }
    }
    if (thread.status !== 'running') {
      this.finish(thread, run, out);
      this.runs.delete(thread.id);
    }
  }

  private diffIdentity(
    previous: LocalThread | undefined,
    thread: LocalThread,
    out: LocalNotification[],
  ): void {
    if (!previous) {
      out.push({
        method: 'thread/started',
        params: { threadId: thread.id, thread: localThreadSummary(thread, this.context()) },
      });
      if (thread.parentThreadId) {
        // As for an adopted ACP sub-agent: an open child view waiting for its thread rehydrates.
        out.push({
          method: 'thread/subagent/adopted',
          params: { threadId: thread.id, parentThreadId: thread.parentThreadId },
        });
      }
    } else if (previous.title !== thread.title) {
      out.push({
        method: 'thread/name/updated',
        params: { threadId: thread.id, threadName: thread.title },
      });
    }
  }

  /**
   * The loop loads the model before it records the user message, so for a while the thread is not
   * running yet and has no run. Its activity (load progress, cancelling the load) is still sent,
   * keyed by the turn the loop will start, while the shell waits for the send to be accepted. A
   * failed load then reaches the shell as the rejected send, keeping the unsent draft.
   */
  private diffLoadingActivity(threads: readonly LocalThread[], out: LocalNotification[]): void {
    const live = this.run();
    const thread = live.threadId ? threads.find((entry) => entry.id === live.threadId) : undefined;
    const loading =
      thread !== undefined &&
      live.turnId !== null &&
      thread.status !== 'running' &&
      (live.phase === 'preparing' || live.phase === 'stopping') &&
      this.lastTurn.get(thread.id) !== live.turnId;
    if (!loading || !live.turnId) {
      this.loading = null;
      return;
    }
    const activity = this.activity(thread);
    const key = activity ? `${live.turnId}|${activity.title}|${activity.detail ?? ''}` : null;
    if (!activity || key === this.loading) {
      return;
    }
    this.loading = key;
    out.push({
      method: 'bridge/agui.event',
      params: {
        threadId: thread.id,
        runId: localRunId(thread.id, live.turnId),
        sourceTurnId: live.turnId,
        event: {
          type: EventType.CUSTOM,
          name: RUN_ACTIVITY_EVENT_NAME,
          value: activity,
          timestamp: Date.now(),
        },
      },
    });
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
    // Continue from the activity already sent while the model loaded instead of repeating it.
    if (this.loading?.startsWith(`${turnId}|`)) {
      run.activity = this.loading.slice(turnId.length + 1);
    }
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

  /**
   * Streams what the run is doing (model loading progress, generating, the running tool) whenever
   * it changes. Runtime phases change without thread changes, so this runs on every diff.
   */
  private diffActivity(thread: LocalThread, run: RunTrack, out: LocalNotification[]): void {
    const activity = this.activity(thread);
    if (!activity) {
      return;
    }
    const key = `${activity.title}|${activity.detail ?? ''}`;
    if (key === run.activity) {
      return;
    }
    run.activity = key;
    this.emit(out, thread.id, run, {
      type: EventType.CUSTOM,
      name: RUN_ACTIVITY_EVENT_NAME,
      value: activity,
    });
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
    toolCalls: () => ReadonlyMap<string, LocalToolCall>,
  ): void {
    const tool = message.tool;
    if (!tool) {
      return;
    }
    this.diffChildren(thread.id, previous, message, run, out);
    // Only a new tool or a status change is described; unchanged history (including an identical
    // message) skips the lookup and the parse of its possibly whole-file arguments. An unchanged
    // settled tool still reaches the end check below, which a newly tracked run reports once.
    if (previous?.tool?.status !== tool.status) {
      const described = describeLocalToolMessage(thread, message, toolCalls());
      if (!previous) {
        this.startTool(thread, tool.callId, described.title, run, out, toolCalls());
      }
      this.emit(out, thread.id, run, {
        type: EventType.CUSTOM,
        name: TOOL_META_EVENT_NAME,
        value: {
          toolCallId: tool.callId,
          kind: described.kind,
          ...localToolStatus(tool.status),
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
        messageId: `tool:${tool.callId}`,
        toolCallId: tool.callId,
        role: 'tool',
        content: message.content || '{}',
      });
    }
  }

  private diffChildren(
    threadId: string,
    previous: LocalMessage | undefined,
    message: LocalMessage,
    run: RunTrack,
    out: LocalNotification[],
  ): void {
    for (const child of message.children ?? []) {
      const prior = previous?.children?.find((entry) => entry.id === child.id);
      if (prior === child) {
        continue;
      }
      const activity = childActivity(threadId, child);
      if (prior && sameContent(childActivity(threadId, prior).content, activity.content)) {
        continue;
      }
      this.emit(out, threadId, run, {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: activity.id,
        activityType: SUBAGENT_ACTIVITY_TYPE,
        content: activity.content,
      });
    }
  }

  private startTool(
    thread: LocalThread,
    toolCallId: string,
    title: string,
    run: RunTrack,
    out: LocalNotification[],
    calls: ReadonlyMap<string, LocalToolCall>,
  ): void {
    this.closeOpenMessages(thread.id, run, out);
    this.emit(out, thread.id, run, {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: title,
    });
    const args = calls.get(toolCallId)?.function.arguments;
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
