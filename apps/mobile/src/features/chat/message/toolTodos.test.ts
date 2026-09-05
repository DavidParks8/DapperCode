import { parseToolTodos } from './toolTodos';

const todos = [
  { content: 'Inspect the tool output', status: 'completed', priority: 'high' },
  { content: 'Render readable tasks', status: 'in_progress', priority: 'medium' },
  { content: 'Verify the result', status: 'pending', priority: 'low' },
];

describe('parseToolTodos', () => {
  it.each(['todo', 'todowrite', 'TodoRead', 'functions.todowrite', 'Update todos'])(
    'reads JSON output from %s',
    (title) => {
      expect(parseToolTodos(title, JSON.stringify(todos, null, 2))).toEqual([
        {
          text: todos[0]?.content,
          status: 'Completed',
          priority: 'high',
          description: null,
        },
        {
          text: todos[1]?.content,
          status: 'In progress',
          priority: 'medium',
          description: null,
        },
        {
          text: todos[2]?.content,
          status: 'Pending',
          priority: 'low',
          description: null,
        },
      ]);
    },
  );

  it.each(['todos', 'todoList'])('reads the %s envelope without dropping descriptions', (key) => {
    expect(
      parseToolTodos(
        'manage_todo_list',
        JSON.stringify({
          [key]: [
            { id: 1, title: 'First task', status: 'not-started', description: 'More detail' },
            { id: 1, title: 'Second task', status: 'in-progress' },
            { title: 'Deferred task', status: 'blocked' },
            { title: 'Removed task', status: 'cancelled' },
          ],
        }),
      ),
    ).toEqual([
      { text: 'First task', status: 'Pending', description: 'More detail', priority: null },
      { text: 'Second task', status: 'In progress', description: null, priority: null },
      { text: 'Deferred task', status: 'Blocked', description: null, priority: null },
      { text: 'Removed task', status: 'Cancelled', description: null, priority: null },
    ]);
  });

  it('keeps empty lists distinct from unrecognized output', () => {
    expect(parseToolTodos('todowrite', '[]')).toEqual([]);
    expect(parseToolTodos('todo', '{"todos":[]}')).toEqual([]);
  });

  it('preserves unfamiliar status text rather than inventing a completion state', () => {
    expect(
      parseToolTodos('todo', '[{"content":"Task","status":"awaiting_review"}]')?.[0]?.status,
    ).toBe('awaiting review');
  });

  it.each([
    '',
    'Unable to update todos',
    '[{"content":"Partial',
    'null',
    '{}',
    '{"todos":null}',
    '[null]',
    '[{"content":"Missing status"}]',
    '[{"content":"   ","status":"pending"}]',
    '[{"content":"Task","status":false}]',
    '[{"content":"Valid","status":"pending"},{"status":"completed"}]',
  ])('leaves malformed or non-todo output visible: %s', (output) => {
    expect(parseToolTodos('todowrite', output)).toBeNull();
  });

  it('does not turn another tool output into a todo list', () => {
    expect(parseToolTodos('read', JSON.stringify(todos))).toBeNull();
  });
});
