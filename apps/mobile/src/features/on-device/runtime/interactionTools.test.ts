import {
  localQuestionAnswers,
  localQuestions,
  parseLocalTasks,
  updateLocalTasks,
} from './interactionTools';
import type { PendingUserInputRequest } from '@bridge/types/types';

const task = { id: 'build', content: 'Build the app', status: 'pending' as const };
const question = { id: 'theme', header: 'Theme', question: 'Choose a theme' };

test('upserts stable task ids, preserves omitted tasks, and removes only explicit ids', () => {
  const first = updateLocalTasks([], { todos: [task] });
  expect(updateLocalTasks(first, { todos: [task] })).toEqual(first);
  const next = updateLocalTasks(first, {
    todos: [
      { ...task, status: 'completed' },
      { ...task, id: 'test', content: 'Test' },
    ],
  });
  expect(next).toHaveLength(2);
  expect(updateLocalTasks(next, { todos: [], remove: ['build'] })).toEqual([next[1]]);
});

test.each(
  [
    [{ ...task, id: '../escape' }],
    [{ ...task, content: ' ' }],
    [{ ...task, content: 'x'.repeat(501) }],
    [{ ...task, status: 'done' }],
    [task, task],
    new Array(65).fill(task),
  ].map((tasks) => ({ tasks })),
)('rejects invalid durable tasks %j', ({ tasks }) => {
  expect(() => parseLocalTasks(tasks)).toThrow();
});

test('rejects conflicting and unknown task operations atomically', () => {
  const previous = [task];
  expect(() => updateLocalTasks(previous, { todos: [task], remove: ['build'] })).toThrow();
  expect(() => updateLocalTasks(previous, { todos: [], replace: true })).toThrow();
  expect(previous).toEqual([task]);
});

test.each([
  {},
  { questions: [] },
  { questions: new Array(9).fill(question) },
  { questions: [question, question] },
  { questions: [{ ...question, multiSelect: 'yes' }] },
  { questions: [{ ...question, header: ' ' }] },
  {
    questions: [
      {
        ...question,
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'B' },
        ],
      },
    ],
  },
])('rejects invalid questions %j', (input) => {
  expect(() => localQuestions(input)).toThrow();
});

test('validates actual answer types, choices, required text, and unknown question ids', () => {
  const request = {
    questions: localQuestions({
      questions: [
        { ...question, options: [{ value: 'light', label: 'Light' }] },
        {
          id: 'langs',
          header: 'Languages',
          question: 'Which?',
          multiSelect: true,
          options: [
            { value: 'ts', label: 'TypeScript' },
            { value: 'rust', label: 'Rust' },
          ],
        },
      ],
    }),
  } as PendingUserInputRequest;
  expect(
    localQuestionAnswers(request, { answers: { theme: 'light', langs: ['ts', 'rust'] } }),
  ).toEqual({ theme: 'light', langs: ['ts', 'rust'] });
  for (const answers of [
    {},
    { theme: 'dark', langs: ['ts'] },
    { theme: 'light', langs: 'ts' },
    { theme: 'light', langs: ['ts', 'ts'] },
    { theme: 'light', langs: [] },
    { theme: 'light', langs: ['ts'], unknown: 'answer' },
  ]) {
    expect(() => localQuestionAnswers(request, { answers })).toThrow();
  }
});
import { localTaskPrompt } from './interactionTools';
import { utf8Bytes } from './threadJournal';

test('persistent task context stays within the smallest model budget without losing saved tasks', () => {
  const tasks = Array.from({ length: 64 }, (_, index) => ({
    id: `task-${index}`,
    content: index === 1 ? 'Fix parser' : 'Long evidence 🦙 '.repeat(30),
    status: index === 1 ? ('in_progress' as const) : ('completed' as const),
  }));
  for (const tokens of [4096, 8192, 16384]) {
    const prompt = localTaskPrompt(tasks, tokens);
    expect(utf8Bytes(prompt)).toBeLessThanOrEqual(Math.min(2048, tokens / 8));
    expect(prompt).toContain('64 total, 63 completed');
    expect(prompt).toContain('task-1');
    expect(prompt).toContain('todo_read');
  }
  expect(tasks).toHaveLength(64);
  expect(tasks[63]?.content).toContain('Long evidence');
});
