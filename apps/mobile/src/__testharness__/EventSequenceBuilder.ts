import { EventType, type AGUIEvent } from '@ag-ui/core';

export interface EventSequenceEntry {
  threadId: string;
  runId: string;
  event: AGUIEvent;
}

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

/**
 * Fluent builder for constructing AG-UI event sequences.
 *
 * All methods return `this` for chaining. Call `.build()` to get the array.
 */
export class EventSequenceBuilder {
  private entries: EventSequenceEntry[] = [];
  private _threadId: string;
  private _runId: string;
  private _messageCounter = 0;
  private _toolCallCounter = 0;

  constructor(threadId?: string, runId?: string) {
    this._threadId = threadId ?? `thread-${Date.now()}`;
    this._runId = runId ?? `${this._threadId}::run-1`;
  }

  get threadId(): string {
    return this._threadId;
  }

  get runId(): string {
    return this._runId;
  }

  /** Override the thread/run IDs for subsequent events. */
  setThread(threadId: string, runId?: string): this {
    this._threadId = threadId;
    if (runId) this._runId = runId;
    return this;
  }

  /** Emit RUN_STARTED. */
  runStarted(threadId?: string, runId?: string): this {
    const tid = threadId ?? this._threadId;
    const rid = runId ?? this._runId;
    return this.push(tid, rid, {
      type: EventType.RUN_STARTED,
      threadId: tid,
      runId: rid,
    });
  }

  /** Emit RUN_FINISHED. */
  runFinished(threadId?: string, runId?: string): this {
    const tid = threadId ?? this._threadId;
    const rid = runId ?? this._runId;
    return this.push(tid, rid, {
      type: EventType.RUN_FINISHED,
      threadId: tid,
      runId: rid,
    });
  }

  /** Emit RUN_ERROR. */
  runError(message: string, threadId?: string, runId?: string): this {
    const tid = threadId ?? this._threadId;
    const rid = runId ?? this._runId;
    return this.push(tid, rid, {
      type: EventType.RUN_ERROR,
      message,
    });
  }

  /** Emit a complete text message (start + content + end). */
  textMessage(content: string, options?: { messageId?: string; role?: string }): this {
    const mid = options?.messageId ?? nextId('msg');
    this.push(this._threadId, this._runId, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: mid,
      role: (options?.role as 'assistant' | 'user' | 'system') ?? 'assistant',
    });
    this.push(this._threadId, this._runId, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: mid,
      delta: content,
    });
    this.push(this._threadId, this._runId, {
      type: EventType.TEXT_MESSAGE_END,
      messageId: mid,
    });
    return this;
  }

  /** Emit TEXT_MESSAGE_START. */
  textStart(messageId?: string, role?: string): this {
    const mid = messageId ?? nextId('msg');
    return this.push(this._threadId, this._runId, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: mid,
      role: (role as 'assistant' | 'user' | 'system') ?? 'assistant',
    });
  }

  /** Emit TEXT_MESSAGE_CONTENT. */
  textContent(delta: string, messageId: string): this {
    return this.push(this._threadId, this._runId, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
    });
  }

  /** Emit TEXT_MESSAGE_END. */
  textEnd(messageId: string): this {
    return this.push(this._threadId, this._runId, {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    });
  }

  /** Emit a complete tool call sequence (start + args + end). */
  toolCall(name: string, args: string, options?: { toolCallId?: string }): this {
    const tcid = options?.toolCallId ?? nextId('tc');
    this.push(this._threadId, this._runId, {
      type: EventType.TOOL_CALL_START,
      toolCallId: tcid,
      toolCallName: name,
    });
    if (args) {
      this.push(this._threadId, this._runId, {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: tcid,
        delta: args,
      });
    }
    this.push(this._threadId, this._runId, {
      type: EventType.TOOL_CALL_END,
      toolCallId: tcid,
    });
    return this;
  }

  /** Emit TOOL_CALL_RESULT. */
  toolResult(toolCallId: string, content: string, messageId?: string): this {
    return this.push(this._threadId, this._runId, {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: messageId ?? nextId('tool-msg'),
      content,
    });
  }

  /** Emit ACTIVITY_SNAPSHOT (used for sub-agent cards). */
  activitySnapshot(
    messageId: string,
    activityType: string,
    content: Record<string, unknown>,
  ): this {
    return this.push(this._threadId, this._runId, {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId,
      activityType,
      content,
      replace: false,
    });
  }

  /** Emit MESSAGES_SNAPSHOT. */
  messagesSnapshot(messages: AGUIEvent extends { messages: infer M } ? M : never): this {
    return this.push(this._threadId, this._runId, {
      type: EventType.MESSAGES_SNAPSHOT,
      messages,
    } as AGUIEvent);
  }

  /** Emit STEP_STARTED. */
  stepStarted(stepName: string): this {
    return this.push(this._threadId, this._runId, {
      type: EventType.STEP_STARTED,
      stepName,
    });
  }

  /** Emit STEP_FINISHED. */
  stepFinished(stepName: string): this {
    return this.push(this._threadId, this._runId, {
      type: EventType.STEP_FINISHED,
      stepName,
    });
  }

  /** Emit a raw event of any type. */
  rawEvent(event: AGUIEvent, threadId?: string, runId?: string): this {
    return this.push(threadId ?? this._threadId, runId ?? this._runId, event);
  }

  /** Build the final event sequence array. */
  build(): EventSequenceEntry[] {
    return [...this.entries];
  }

  private push(threadId: string, runId: string, event: AGUIEvent): this {
    this.entries.push({ threadId, runId, event });
    return this;
  }
}

/** Convenience: create a builder for a given thread. */
export function sequence(threadId?: string, runId?: string): EventSequenceBuilder {
  return new EventSequenceBuilder(threadId, runId);
}
