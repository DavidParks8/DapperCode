import { EventType } from '@ag-ui/core';

import { TOOL_META_EVENT_NAME } from '@bridge/toolMeta';
import type { LocalMessage, LocalThread, LocalToolCall } from '../runtime/types';
import { LocalEventProjector, type LocalNotification } from './events';
import { localThreadSnapshot, type LocalThreadProjectionContext } from './wire';

const MARKER = '/*whole-file-contents*/';
const TOOLS = 20;

const context = (): LocalThreadProjectionContext => ({
  workspaces: [{ id: 'ws-one', name: 'Demo', isRepository: true }],
  models: [],
});

const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();

let toolCallReads = 0;
let parse: jest.SpyInstance;

beforeEach(() => {
  toolCallReads = 0;
  parse = jest.spyOn(JSON, 'parse');
});

afterEach(() => {
  parse.mockRestore();
});

/** JSON.parse calls of whole-file tool arguments since the last reset. */
function argumentParses(): number {
  return parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes(MARKER))
    .length;
}

function resetCounters(): void {
  toolCallReads = 0;
  parse.mockClear();
}

/** An assistant message whose tool calls count every read, i.e. every lookup that scans it. */
function assistantWithCall(id: string, call: LocalToolCall): LocalMessage {
  const message: LocalMessage = { id, role: 'assistant', content: '', createdAt: at(1) };
  const calls = [call];
  Object.defineProperty(message, 'toolCalls', {
    enumerable: true,
    get: () => {
      toolCallReads += 1;
      return calls;
    },
  });
  return message;
}

/** A running turn whose state is replaced immutably, the way the runtime publishes it. */
class Turn {
  private messages: LocalMessage[];
  private status: LocalThread['status'] = 'running';
  private activeTurnId: string | null;

  constructor(
    turnId: string,
    private previous: LocalMessage[] = [],
  ) {
    this.activeTurnId = turnId;
    this.messages = [
      ...previous,
      { id: `user-${turnId}`, role: 'user', content: 'Write the files', createdAt: at(0) },
    ];
  }

  thread(): LocalThread {
    return {
      version: 1,
      id: 'thread-1',
      title: 'Write the files',
      workspaceId: 'ws-one',
      modelId: 'qwen3-1.7b-q4-k-m',
      createdAt: at(0),
      updatedAt: at(this.messages.length),
      status: this.status,
      activeTurnId: this.activeTurnId,
      lastSubmissionId: null,
      lastError: null,
      messages: [...this.messages],
    };
  }

  history(): LocalMessage[] {
    return this.messages;
  }

  startTool(index: number, name = 'write_file'): void {
    const callId = `call-${String(index)}`;
    const args = JSON.stringify({
      path: `src/file-${String(index)}.ts`,
      content: `${MARKER}${'x'.repeat(10_000)}`,
    });
    this.messages = [
      ...this.messages,
      assistantWithCall(`assistant-${String(index)}`, {
        id: callId,
        type: 'function',
        function: { name, arguments: args },
      }),
      {
        id: `tool-${String(index)}`,
        role: 'tool',
        content: '',
        createdAt: at(index),
        tool: { callId, name, status: 'running', startedAt: at(index) },
      },
    ];
  }

  finishTool(index: number): void {
    this.messages = this.messages.map((message) =>
      message.id === `tool-${String(index)}` && message.tool
        ? {
            ...message,
            content: '{"ok":true}',
            tool: { ...message.tool, status: 'completed', completedAt: at(index + 1) },
          }
        : message,
    );
  }

  stream(content: string): void {
    const answer: LocalMessage = { id: 'answer', role: 'assistant', content, createdAt: at(2) };
    const exists = this.messages.some((message) => message.id === 'answer');
    this.messages = exists
      ? this.messages.map((message) => (message.id === 'answer' ? answer : message))
      : [...this.messages, answer];
  }

  settle(): void {
    this.status = 'complete';
    this.activeTurnId = null;
  }
}

function eventsOf(notifications: LocalNotification[]): Record<string, unknown>[] {
  return notifications
    .filter((notification) => notification.method === 'bridge/agui.event')
    .map((notification) => notification.params['event'] as Record<string, unknown>);
}

function summarize(notifications: LocalNotification[]): string[] {
  return eventsOf(notifications).map((event) => {
    const type = event['type'] as EventType;
    if (type === EventType.CUSTOM && event['name'] === TOOL_META_EVENT_NAME) {
      const value = event['value'] as Record<string, unknown>;
      return `META ${String(value['toolCallId'])} ${String(value['status'])} ${String(value['title'])}`;
    }
    if (type === EventType.TOOL_CALL_START) {
      return `${type} ${String(event['toolCallId'])} ${String(event['toolCallName'])}`;
    }
    if (type === EventType.TOOL_CALL_ARGS) {
      return `${type} ${String(event['toolCallId'])} ${String((event['delta'] as string).length)}`;
    }
    if (type === EventType.TOOL_CALL_END || type === EventType.TOOL_CALL_RESULT) {
      return `${type} ${String(event['toolCallId'])}`;
    }
    if (type === EventType.TEXT_MESSAGE_CONTENT) {
      return `${type} ${String(event['messageId'])} ${String(event['delta'])}`;
    }
    return type;
  });
}

/** Runs a turn of `TOOLS` write_file calls, flushing after every change like the server does. */
function runTools(projector: LocalEventProjector, turn: Turn): LocalNotification[] {
  const out = [...projector.diff([turn.thread()])];
  for (let index = 1; index <= TOOLS; index += 1) {
    turn.startTool(index);
    out.push(...projector.diff([turn.thread()]));
    turn.finishTool(index);
    out.push(...projector.diff([turn.thread()]));
  }
  return out;
}

describe('LocalEventProjector', () => {
  it('parses each tool call once while its tool starts and completes', () => {
    const projector = new LocalEventProjector(context);
    projector.prime([]);
    const out = runTools(projector, new Turn('turn-1'));
    // Each call's whole-file arguments are parsed once, though it is described when it starts and
    // again when it completes.
    expect(argumentParses()).toBe(TOOLS);
    expect(
      eventsOf(out)
        .filter((event) => event['type'] === EventType.TOOL_CALL_RESULT)
        .map((event) => [event['toolCallId'], event['messageId']]),
    ).toEqual(
      Array.from({ length: TOOLS }, (_, index) => [
        `call-${String(index + 1)}`,
        `tool:call-${String(index + 1)}`,
      ]),
    );
    expect(summarize(out).filter((entry) => entry.startsWith('META'))).toEqual(
      Array.from({ length: TOOLS }, (_, offset) => {
        const title = `Write src/file-${String(offset + 1)}.ts`;
        return [
          `META call-${String(offset + 1)} in_progress ${title}`,
          `META call-${String(offset + 1)} completed ${title}`,
        ];
      }).flat(),
    );
  });

  it('streams text after many tools without re-describing or re-parsing their calls', () => {
    const projector = new LocalEventProjector(context);
    projector.prime([]);
    const turn = new Turn('turn-1');
    runTools(projector, turn);

    resetCounters();
    const streamed: LocalNotification[] = [];
    for (const text of ['Done', 'Done writing', 'Done writing the files.']) {
      turn.stream(text);
      streamed.push(...projector.diff([turn.thread()]));
    }
    expect(summarize(streamed)).toEqual([
      EventType.TEXT_MESSAGE_START,
      `${EventType.TEXT_MESSAGE_CONTENT} answer Done`,
      `${EventType.TEXT_MESSAGE_CONTENT} answer  writing`,
      `${EventType.TEXT_MESSAGE_CONTENT} answer  the files.`,
    ]);
    // Streaming-only flushes neither look up nor parse the arguments of unchanged tools.
    expect(toolCallReads).toBe(0);
    expect(argumentParses()).toBe(0);

    turn.settle();
    expect(summarize(projector.diff([turn.thread()]))).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(toolCallReads).toBe(0);
    expect(argumentParses()).toBe(0);
  });

  it('projects a multi-tool, multi-turn thread into the same events', () => {
    const projector = new LocalEventProjector(context);
    projector.prime([]);
    const first = new Turn('turn-1');
    const out = [...projector.diff([first.thread()])];
    first.stream('Reading');
    out.push(...projector.diff([first.thread()]));
    first.startTool(1, 'read_file');
    out.push(...projector.diff([first.thread()]));
    first.startTool(2);
    out.push(...projector.diff([first.thread()]));
    first.finishTool(2);
    first.finishTool(1);
    out.push(...projector.diff([first.thread()]));
    first.settle();
    out.push(...projector.diff([first.thread()]));

    const second = new Turn('turn-2', first.history());
    out.push(...projector.diff([second.thread()]));
    second.startTool(3, 'edit_file');
    out.push(...projector.diff([second.thread()]));
    second.finishTool(3);
    second.settle();
    out.push(...projector.diff([second.thread()]));

    const args = String(first.history()[2]?.toolCalls?.[0]?.function.arguments.length);
    expect(summarize(out)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      `${EventType.TEXT_MESSAGE_CONTENT} answer Reading`,
      EventType.TEXT_MESSAGE_END,
      `${EventType.TOOL_CALL_START} call-1 Read src/file-1.ts`,
      `${EventType.TOOL_CALL_ARGS} call-1 ${args}`,
      'META call-1 in_progress Read src/file-1.ts',
      `${EventType.TOOL_CALL_START} call-2 Write src/file-2.ts`,
      `${EventType.TOOL_CALL_ARGS} call-2 ${args}`,
      'META call-2 in_progress Write src/file-2.ts',
      'META call-1 completed Read src/file-1.ts',
      `${EventType.TOOL_CALL_END} call-1`,
      `${EventType.TOOL_CALL_RESULT} call-1`,
      'META call-2 completed Write src/file-2.ts',
      `${EventType.TOOL_CALL_END} call-2`,
      `${EventType.TOOL_CALL_RESULT} call-2`,
      EventType.RUN_FINISHED,
      // A new run reports earlier settled tools once, as it always has.
      EventType.RUN_STARTED,
      `${EventType.TOOL_CALL_END} call-1`,
      `${EventType.TOOL_CALL_RESULT} call-1`,
      `${EventType.TOOL_CALL_END} call-2`,
      `${EventType.TOOL_CALL_RESULT} call-2`,
      `${EventType.TOOL_CALL_START} call-3 Edit src/file-3.ts`,
      `${EventType.TOOL_CALL_ARGS} call-3 ${args}`,
      'META call-3 in_progress Edit src/file-3.ts',
      'META call-3 completed Edit src/file-3.ts',
      `${EventType.TOOL_CALL_END} call-3`,
      `${EventType.TOOL_CALL_RESULT} call-3`,
      EventType.RUN_FINISHED,
    ]);
  });
});

describe('localThreadSnapshot', () => {
  it('describes every tool of a thread with a single pass over its calls', () => {
    const turn = new Turn('turn-1');
    for (let index = 1; index <= TOOLS; index += 1) {
      turn.startTool(index);
      if (index < TOOLS) {
        turn.finishTool(index);
      }
    }
    const thread = turn.thread();

    resetCounters();
    const snapshot = localThreadSnapshot(thread, context());
    // One read per assistant message instead of a scan of the thread for each tool.
    expect(toolCallReads).toBe(TOOLS);
    expect(argumentParses()).toBe(TOOLS);
    const acp = snapshot.acpSnapshot!;
    expect(acp.tools.map((tool) => [tool.id, tool.kind, tool.status, tool.title])).toEqual(
      Array.from({ length: TOOLS }, (_, offset) => {
        const index = offset + 1;
        return [
          `call-${String(index)}`,
          'edit',
          index < TOOLS ? 'completed' : 'in_progress',
          `Write src/file-${String(index)}.ts`,
        ];
      }),
    );
    expect(acp.timeline?.map((entry) => [entry.kind, entry.canonicalId])).toEqual([
      ['message', 'user-turn-1'],
      ...Array.from({ length: TOOLS }, (_, offset) => ['tool', `call-${String(offset + 1)}`]),
    ]);
    expect(acp.active).toMatchObject({
      sourceTurnId: 'turn-1',
      toolIds: [`call-${String(TOOLS)}`],
    });

    // Reading the same thread again reuses each call's description instead of re-parsing it.
    resetCounters();
    expect(localThreadSnapshot(thread, context())).toEqual(snapshot);
    expect(argumentParses()).toBe(0);
  });
});
