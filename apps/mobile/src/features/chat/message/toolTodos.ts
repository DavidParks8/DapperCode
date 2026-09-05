import { lookupDispatchEntry, readString, toRecord } from '@shared/runtimeValidation';

export interface ToolTodo {
  text: string;
  status: string;
  description: string | null;
  priority: string | null;
}

const STATUS_LABELS: Partial<Record<string, string>> = {
  pending: 'Pending',
  notstarted: 'Pending',
  inprogress: 'In progress',
  completed: 'Completed',
  complete: 'Completed',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  blocked: 'Blocked',
};

export function isTodoToolTitle(title: string): boolean {
  return /(?:^|[^a-z])todo(?:s|write|read)?(?:$|[^a-z])/i.test(title);
}

export function parseToolTodos(title: string, text: string): ToolTodo[] | null {
  if (!isTodoToolTitle(title)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  const record = toRecord(value);
  const entries: unknown = Array.isArray(value)
    ? value
    : (record?.['todos'] ?? record?.['todoList']);
  if (!Array.isArray(entries)) {
    return null;
  }
  const todos = entries.map(parseTodo);
  // Leave the entire response visible if any entry cannot be rendered faithfully.
  return todos.every((todo): todo is ToolTodo => todo !== null) ? todos : null;
}

function parseTodo(value: unknown): ToolTodo | null {
  const item = toRecord(value);
  if (!item) {
    return null;
  }
  const text = todoString(item['content']) ?? todoString(item['title']);
  const status = todoString(item['status']);
  if (!text || !status) {
    return null;
  }
  return {
    text,
    status:
      lookupDispatchEntry(STATUS_LABELS, status.toLowerCase().replace(/[^a-z]/g, '')) ??
      status.replace(/[_-]/g, ' '),
    description: todoString(item['description']),
    priority: todoString(item['priority']),
  };
}

function todoString(value: unknown): string | null {
  return readString(value)?.trim() || null;
}
