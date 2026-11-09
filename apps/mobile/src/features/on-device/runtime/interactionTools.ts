import type {
  PendingUserInputRequest,
  ResolveUserInputRequest,
  UserInputQuestion,
  UserInputValue,
} from '@bridge/types/types';
import { argumentsRecord, LocalToolInputError, text } from './toolArguments';
import { toolDefinition } from './toolDefinition';
import type { LocalThreadRepository } from './threads';
import type { LocalToolCall } from './types';

export interface LocalTask {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const identifier = { type: 'string', pattern: ID.source, maxLength: 64 };
const taskProperties = {
  id: identifier,
  content: { type: 'string', minLength: 1, maxLength: 500 },
  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
};

export const INTERACTION_TOOL_DEFINITIONS = [
  toolDefinition(
    'ask_user',
    'Ask the user 1-8 questions and wait for their reply. No answer is assumed. Use options for choices, multiSelect for multiple choices, and allowFreeText for a custom answer. Cancellation returns an error; do not retry unless asked.',
    {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'header', 'question'],
          properties: {
            id: identifier,
            header: { type: 'string', minLength: 1, maxLength: 100 },
            question: { type: 'string', minLength: 1, maxLength: 2000 },
            multiSelect: { type: 'boolean' },
            allowFreeText: { type: 'boolean' },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['value', 'label'],
                properties: {
                  value: identifier,
                  label: { type: 'string', minLength: 1, maxLength: 100 },
                  description: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
      },
    },
    ['questions'],
    { kind: 'think', approval: null },
  ),
  toolDefinition(
    'todo_read',
    'Read this conversation’s persistent task list, independent of model context. Task completion is not proof the user’s request is finished.',
    {},
    [],
    { kind: 'think', approval: null },
  ),
  toolDefinition(
    'todo_write',
    'Upsert tasks by stable id (id, content, status); omitted tasks are preserved. Reusing an id updates it, never duplicates it. Remove only explicitly listed ids. Maximum 64 tasks. This does not finish the user’s request.',
    {
      todos: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'object',
          properties: taskProperties,
          required: ['id', 'content', 'status'],
          additionalProperties: false,
        },
      },
      remove: { type: 'array', maxItems: 64, items: identifier },
    },
    ['todos'],
    { kind: 'think', approval: null },
  ),
];

function id(record: Record<string, unknown>, key: string): string {
  const value = text(record, key, 64);
  if (!ID.test(value)) {
    throw new LocalToolInputError(
      'Use a stable alphanumeric id with optional hyphens/underscores.',
    );
  }
  return value;
}

function nonblank(record: Record<string, unknown>, key: string, maximum: number): string {
  const value = text(record, key, maximum).trim();
  if (!value) {
    throw new LocalToolInputError(`"${key}" cannot be blank.`);
  }
  return value;
}

function boundedArray(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new LocalToolInputError(`Expected ${String(minimum)}-${String(maximum)} entries.`);
  }
  return value;
}

function unique(values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw new LocalToolInputError('Ids and choice values must be unique.');
  }
}

export function localQuestions(input: unknown): UserInputQuestion[] {
  const args = argumentsRecord(input, ['questions']);
  const questions = boundedArray(args['questions'], 8, 1).map((value): UserInputQuestion => {
    const item = argumentsRecord(value, [
      'id',
      'header',
      'question',
      'options',
      'multiSelect',
      'allowFreeText',
    ]);
    for (const key of ['multiSelect', 'allowFreeText']) {
      if (item[key] !== undefined && typeof item[key] !== 'boolean') {
        throw new LocalToolInputError(`"${key}" must be a boolean.`);
      }
    }
    const options =
      item['options'] === undefined
        ? null
        : boundedArray(item['options'], 12, 1).map((option) => {
            const entry = argumentsRecord(option, ['value', 'label', 'description']);
            return {
              value: id(entry, 'value'),
              label: nonblank(entry, 'label', 100),
              description:
                entry['description'] === undefined ? '' : text(entry, 'description', 500, 0),
            };
          });
    if (options) {
      unique(options.map((option) => option.value));
    }
    return {
      id: id(item, 'id'),
      header: nonblank(item, 'header', 100),
      question: nonblank(item, 'question', 2000),
      options,
      isOther: !options || item['allowFreeText'] === true,
      isSecret: false,
      required: true,
      fieldType: item['multiSelect'] === true ? 'string-array' : 'string',
    };
  });
  unique(questions.map((question) => question.id));
  return questions;
}

export function localQuestionAnswers(
  request: PendingUserInputRequest,
  input: unknown,
): Record<string, UserInputValue> {
  const args = argumentsRecord(input, ['answers', 'action']);
  if (args['action'] !== undefined && args['action'] !== 'submit') {
    if (args['action'] !== 'cancel' && args['action'] !== 'decline') {
      throw new LocalToolInputError('Choose cancel or decline.');
    }
    throw new LocalToolInputError('A dismissed question has no answers.');
  }
  const answers = argumentsRecord(
    args['answers'],
    request.questions.map((question) => question.id),
  );
  const result: Record<string, UserInputValue> = {};
  for (const question of request.questions) {
    const value = answers[question.id];
    const values = question.fieldType === 'string-array' ? boundedArray(value, 12, 1) : [value];
    if (values.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 2000)) {
      throw new LocalToolInputError(`Answer "${question.header}" with nonempty text.`);
    }
    const strings = values as string[];
    unique(strings);
    if (
      question.options &&
      !question.isOther &&
      strings.some((entry) => !question.options?.some((option) => option.value === entry))
    ) {
      throw new LocalToolInputError(`Choose a listed option for "${question.header}".`);
    }
    result[question.id] = question.fieldType === 'string-array' ? strings : strings.join('');
  }
  return result;
}

export function parseLocalTasks(input: unknown): LocalTask[] {
  const tasks = boundedArray(input, 64).map((value): LocalTask => {
    const item = argumentsRecord(value, ['id', 'content', 'status']);
    const status = item['status'];
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new LocalToolInputError('Task status must be pending, in_progress, or completed.');
    }
    return { id: id(item, 'id'), content: nonblank(item, 'content', 500), status };
  });
  unique(tasks.map((task) => task.id));
  return tasks;
}

export function updateLocalTasks(previous: readonly LocalTask[], input: unknown): LocalTask[] {
  const args = argumentsRecord(input, ['todos', 'remove']);
  const updates = parseLocalTasks(args['todos']);
  const remove = boundedArray(args['remove'] ?? [], 64).map((value) => id({ id: value }, 'id'));
  unique(remove);
  if (updates.some((task) => remove.includes(task.id))) {
    throw new LocalToolInputError('Cannot update and remove the same task.');
  }
  const tasks = new Map(previous.map((task) => [task.id, task]));
  for (const key of remove) {
    tasks.delete(key);
  }
  for (const task of updates) {
    tasks.set(task.id, task);
  }
  return parseLocalTasks([...tasks.values()]);
}

export type LocalInputReply = Pick<ResolveUserInputRequest, 'answers' | 'action'>;

export interface LocalInteractionRun {
  threadId: string;
  turnId: string;
  stopped: boolean;
  controller: AbortController;
  input: {
    request: PendingUserInputRequest;
    resolve: (reply: unknown) => void;
    reject: (error: Error) => void;
  } | null;
}

export function resolveLocalInput(
  run: LocalInteractionRun | null,
  requestId: string,
  reply: LocalInputReply,
  resumed: () => void,
): void {
  const pending = run?.input;
  if (!run || run.stopped || !pending || pending.request.requestId !== requestId) {
    throw new Error('This question is no longer pending.');
  }
  // Invalid answers leave the request pending so the user can correct them.
  const answers =
    reply.action === undefined || reply.action === 'submit'
      ? localQuestionAnswers(pending.request, reply)
      : null;
  if (
    reply.action !== undefined &&
    reply.action !== 'submit' &&
    reply.action !== 'cancel' &&
    reply.action !== 'decline'
  ) {
    throw new Error('Choose cancel or decline.');
  }
  run.input = null;
  resumed();
  if (answers) {
    pending.resolve({ answers });
  } else {
    pending.reject(
      new Error(
        `The user ${reply.action === 'cancel' ? 'cancelled' : 'declined'} the question. No answer was provided. Do not retry unless asked.`,
      ),
    );
  }
}

export function isInteractionTool(name: string): boolean {
  return INTERACTION_TOOL_DEFINITIONS.some((tool) => tool.definition.function.name === name);
}

/** Conversation-local tools need run identity, never a path inside the Git workspace. */
export async function executeInteractionTool(
  threads: LocalThreadRepository,
  run: LocalInteractionRun,
  call: LocalToolCall,
  args: unknown,
  waiting: () => void,
): Promise<unknown> {
  if (call.function.name === 'todo_read') {
    argumentsRecord(args, []);
    return { todos: threads.get(run.threadId).tasks ?? [] };
  }
  if (call.function.name === 'todo_write') {
    const tasks = updateLocalTasks(threads.get(run.threadId).tasks ?? [], args);
    threads.change(run.threadId, (thread) => ({ ...thread, tasks }));
    await threads.save(run.threadId);
    // A task result is acknowledged only after its conversation journal is durable.
    await threads.flush();
    return { todos: tasks };
  }
  const questions = localQuestions(args);
  const request: PendingUserInputRequest = {
    requestId: call.id,
    agentId: 'on-device',
    threadId: run.threadId,
    turnId: run.turnId,
    itemId: call.id,
    message: questions.map((question) => question.question).join('\n'),
    requestedAt: new Date().toISOString(),
    questions,
  };
  const { signal } = run.controller;
  let abort: () => void = () => undefined;
  const answer = new Promise<unknown>((resolve, reject) => {
    run.input = { request, resolve, reject };
    abort = () => reject(new Error('Stopped before the user answered this question.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
  waiting();
  try {
    return await answer;
  } finally {
    signal.removeEventListener('abort', abort);
    run.input = null;
  }
}
