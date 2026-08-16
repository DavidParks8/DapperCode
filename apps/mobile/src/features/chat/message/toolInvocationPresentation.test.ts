import type { ChatToolKind, ChatToolStatus } from '@bridge/types/types';
import type { ToolInvocation } from './toolInvocationModel';
import { resolveToolInvocationHeader } from './toolInvocationPresentation';

const EXPECTED_ACTIONS: Record<ChatToolKind, Record<ChatToolStatus, string>> = {
  read: {
    pending: 'Waiting to read',
    in_progress: 'Reading',
    completed: 'Read',
    failed: 'Failed to read',
  },
  edit: {
    pending: 'Waiting to edit',
    in_progress: 'Editing',
    completed: 'Edited',
    failed: 'Failed to edit',
  },
  delete: {
    pending: 'Waiting to delete',
    in_progress: 'Deleting',
    completed: 'Deleted',
    failed: 'Failed to delete',
  },
  move: {
    pending: 'Waiting to move',
    in_progress: 'Moving',
    completed: 'Moved',
    failed: 'Failed to move',
  },
  search: {
    pending: 'Waiting to search',
    in_progress: 'Searching',
    completed: 'Searched',
    failed: 'Failed to search',
  },
  execute: {
    pending: 'Waiting to run',
    in_progress: 'Running',
    completed: 'Ran',
    failed: 'Failed to run',
  },
  think: {
    pending: 'Waiting to think',
    in_progress: 'Thinking',
    completed: 'Thought',
    failed: 'Failed to think',
  },
  fetch: {
    pending: 'Waiting to fetch',
    in_progress: 'Fetching',
    completed: 'Fetched',
    failed: 'Failed to fetch',
  },
  switch_mode: {
    pending: 'Waiting to switch mode',
    in_progress: 'Switching mode',
    completed: 'Switched mode',
    failed: 'Failed to switch mode',
  },
  other: {
    pending: 'Waiting',
    in_progress: 'Running',
    completed: 'Ran',
    failed: 'Failed',
  },
};

function invocation(kind: ChatToolKind, status: ChatToolStatus): ToolInvocation {
  return {
    id: `${kind}-${status}`,
    kind,
    status,
    title: kind,
    startedAtMs: null,
    completedAtMs: null,
    statusLanguage: true,
    monospaceTitle: kind === 'execute',
    isError: status === 'failed',
    locations: [],
    diffs: [],
    terminals: [],
    textLines: [],
    images: [],
    truncated: false,
    empty: true,
  };
}

describe('tool invocation status language', () => {
  it('defines every status phrase for every known tool kind', () => {
    for (const [kind, statuses] of Object.entries(EXPECTED_ACTIONS)) {
      for (const [status, action] of Object.entries(statuses)) {
        expect(
          resolveToolInvocationHeader(invocation(kind as ChatToolKind, status as ChatToolStatus))
            .label,
        ).toBe(action);
      }
    }
  });
});
