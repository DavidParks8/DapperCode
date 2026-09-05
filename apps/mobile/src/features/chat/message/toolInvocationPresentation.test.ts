import type { ChatToolKind, ChatToolStatus } from '@bridge/types/types';
import type { ToolInvocation } from './toolInvocationModel';
import {
  resolveToolInvocationFiles,
  resolveToolInvocationHeader,
} from './toolInvocationPresentation';

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

  describe('per-file patch progress', () => {
    it('counts additions and removals, retaining unchanged files as zero rather than unknown', () => {
      const value = {
        ...invocation('edit', 'in_progress'),
        diffs: [
          { path: 'added.ts', oldText: null, newText: 'one\ntwo\n' },
          { path: 'deleted.ts', oldText: 'old\n', newText: '' },
          { path: 'unchanged.ts', oldText: 'same\n', newText: 'same\n' },
        ],
      };
      expect(resolveToolInvocationFiles(value)).toEqual([
        { path: 'added.ts', additions: 2, deletions: 0 },
        { path: 'deleted.ts', additions: 0, deletions: 1 },
        { path: 'unchanged.ts', additions: 0, deletions: 0 },
      ]);
    });

    it('deduplicates location-only files without inventing counts or an incomplete total', () => {
      const value = {
        ...invocation('edit', 'in_progress'),
        diffs: [{ path: './src//app.ts', oldText: 'old', newText: 'new' }],
        locations: [
          { path: 'src/app.ts', line: 1 },
          { path: 'other.ts', line: 2 },
          { path: 'other.ts', line: 3 },
        ],
      };
      expect(resolveToolInvocationFiles(value)).toEqual([
        { path: 'src/app.ts', additions: 1, deletions: 1 },
        { path: 'other.ts', additions: null, deletions: null },
      ]);
      expect(resolveToolInvocationHeader(value).label).toBe('Editing 2 files');
      expect(resolveToolInvocationFiles({ ...value, kind: 'read', diffs: [] })).toEqual([]);
    });

    it('does not turn unavailable diffs into zero changes', () => {
      const value = {
        ...invocation('edit', 'completed'),
        diffs: [{ path: 'large.ts', oldText: 'old', newText: 'x'.repeat(16 * 1024) }],
      };
      expect(resolveToolInvocationFiles(value)).toEqual([
        { path: 'large.ts', additions: null, deletions: null },
      ]);
      expect(resolveToolInvocationHeader(value).label).toBe('Edited large.ts');
    });
  });
});
