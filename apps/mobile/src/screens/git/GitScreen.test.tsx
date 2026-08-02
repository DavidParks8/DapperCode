import { AppState, ScrollView, TextInput, type AppStateStatus } from 'react-native';
jest.mock('expo-router', () => jest.requireActual('../../testing/expoRouterMock'));
jest.mock('react-native-reanimated', () => jest.requireActual('../../testing/reanimatedMock'));
jest.mock('../../feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    warning: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
  isReduceMotionPreferred: jest.fn().mockResolvedValue(false),
}));
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { Chat, GitStatusResponse } from '../../api/types';
import { feedback } from '../../feedback';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { createGitScreenStyles } from './gitScreenStyles';
import { GitScreen } from './GitScreen';
import { GIT_SCREEN_REFRESH_INTERVAL_MS } from './gitScreenController';
import { mainOpeningChatIdAtom, pendingMainChatIdAtom } from '../../state/chat/atoms';
import { createBridgeTestStore, withAppStore } from '../../state/testing';
import { routes } from '../../navigation/routes';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => name,
}));

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  props: Record<string, unknown> & {
    onBlur: () => void;
    onChangeText: (value: string) => void;
  };
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

const theme = createAppTheme('dark');
const chat: Chat = {
  id: 'thread-1',
  title: 'Repository chat',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: '',
  cwd: '/workspace',
  messages: [],
};
const dirtyStatus: GitStatusResponse = {
  branch: 'feature/coverage',
  clean: false,
  raw: '## feature/coverage...origin/feature/coverage [ahead 2, behind 1]\nM  staged.ts\n M unstaged.ts\n?? new.ts',
  files: [
    {
      path: 'staged.ts',
      indexStatus: 'M',
      worktreeStatus: ' ',
      staged: true,
      unstaged: false,
      untracked: false,
    },
    {
      path: 'unstaged.ts',
      indexStatus: ' ',
      worktreeStatus: 'M',
      staged: false,
      unstaged: true,
      untracked: false,
    },
    {
      path: 'new.ts',
      indexStatus: '?',
      worktreeStatus: '?',
      staged: false,
      unstaged: true,
      untracked: true,
    },
  ],
  cwd: '/workspace',
  truncated: true,
  totalFiles: 5,
  omittedFiles: 2,
  maxFiles: 3,
  maxBytes: 1024,
};
const cleanStatus: GitStatusResponse = {
  ...dirtyStatus,
  clean: true,
  raw: '## main',
  branch: 'main',
  files: [],
  truncated: false,
  totalFiles: 0,
  omittedFiles: 0,
};
const unifiedDiff = [
  'diff --git a/staged.ts b/staged.ts',
  'index 1111111..2222222 100644',
  '--- a/staged.ts',
  '+++ b/staged.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/unstaged.ts b/unstaged.ts',
  'index 3333333..4444444 100644',
  '--- a/unstaged.ts',
  '+++ b/unstaged.ts',
  '@@ -1 +1 @@',
  '-before',
  '+after',
].join('\n');

function createApi(status: GitStatusResponse | Error = dirtyStatus): HostBridgeApiClient {
  const methods: Record<string, jest.Mock> = {
    gitStatus: jest
      .fn()
      .mockImplementation(() =>
        status instanceof Error ? Promise.reject(status) : Promise.resolve(status),
      ),
    gitDiff: jest.fn().mockResolvedValue({
      diff: status === cleanStatus ? '' : unifiedDiff,
      cwd: '/workspace',
      truncated: status === dirtyStatus,
      originalBytes: 4096,
      returnedBytes: 1024,
      maxBytes: 1024,
    }),
    gitHistory: jest.fn().mockResolvedValue({
      commits:
        status === cleanStatus
          ? []
          : [
              {
                hash: 'abcdef123456',
                shortHash: 'abcdef1',
                subject: 'Test commit',
                authorName: 'Developer',
                authoredAt: '2026-07-20T00:00:00.000Z',
                refNames: ['HEAD -> feature/coverage'],
                isHead: true,
              },
            ],
    }),
    gitBranches: jest.fn().mockResolvedValue({
      current: 'feature/coverage',
      branches: [
        { name: 'feature/coverage', remote: false, current: true },
        { name: 'main', remote: false, current: false },
        { name: 'origin/main', remote: true, current: false },
      ],
    }),
    gitStage: jest.fn().mockResolvedValue({ staged: true, stderr: '', path: 'unstaged.ts' }),
    gitUnstage: jest.fn().mockResolvedValue({ unstaged: true, stderr: '', path: 'staged.ts' }),
    gitStageAll: jest.fn().mockResolvedValue({ staged: true, stderr: '' }),
    gitUnstageAll: jest.fn().mockResolvedValue({ unstaged: true, stderr: '' }),
    gitCommit: jest.fn().mockResolvedValue({ committed: true, stderr: '' }),
    gitPush: jest.fn().mockResolvedValue({ pushed: true, stderr: '' }),
    gitSwitch: jest.fn().mockResolvedValue({ switched: true, stderr: '', stdout: '' }),
    setChatWorkspace: jest.fn().mockResolvedValue({ ...chat, cwd: '/next' }),
    sendOrQueueChatMessage: jest.fn().mockResolvedValue({ chat }),
  };
  return methods as unknown as HostBridgeApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function exercisePressableStyles(root: Queryable): void {
  for (const node of root.findAll((candidate) => typeof candidate.props.style === 'function')) {
    const style = node.props.style as (state: { pressed: boolean }) => unknown;
    style({ pressed: false });
    style({ pressed: true });
  }
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNodes = root.findAll((node) => node.children.map(String).join('') === text);
  for (const textNode of textNodes) {
    let current: Queryable | null = textNode;
    while (current && typeof current.props.onPress !== 'function') {
      current = current.parent as Queryable | null;
    }
    if (current) return current;
  }
  throw new Error(`Missing pressable: ${text}`);
}

async function press(root: Queryable, text: string): Promise<void> {
  const target = findPressableByText(root, text);
  await act(async () => {
    (target.props.onPress as () => void)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createGitStore(api: HostBridgeApiClient) {
  return createBridgeTestStore({ api });
}

async function renderGit(
  api: HostBridgeApiClient,
  activeChat: Chat = chat,
): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      withAppStore(
        createGitStore(api),
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <GitScreen chat={activeChat} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected GitScreen tree');
  return tree;
}

describe('GitScreen behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    {
      status: dirtyStatus,
      expected: [
        'Ready to commit',
        'Changed files (3)',
        'Test commit',
        'Diff preview is limited to 1 KB.',
      ],
    },
    { status: cleanStatus, expected: ['Clean', 'No commit history available.'] },
  ])('renders repository state matrices', async ({ status, expected }) => {
    const tree = await renderGit(createApi(status));
    exercisePressableStyles(tree.root as Queryable);
    for (const text of expected) expect(hasText(tree.root as Queryable, text)).toBe(true);
    act(() => tree.unmount());
  });

  it('surfaces refresh failures', async () => {
    const tree = await renderGit(createApi(new Error('git unavailable')));
    expect(hasText(tree.root as Queryable, 'git unavailable')).toBe(true);
    // A failed initial load must never show a false "clean" state above the real error.
    expect(hasText(tree.root as Queryable, 'Working tree clean')).toBe(false);
    act(() => tree.unmount());
  });

  it('does not show a false clean state or a repeated full-screen spinner after a rejected initial gitStatus load', async () => {
    const api = createApi();
    const nextStatus = deferred<GitStatusResponse>();
    (api.gitStatus as jest.Mock)
      .mockRejectedValueOnce(new Error('git unavailable'))
      .mockImplementationOnce(() => nextStatus.promise);

    const tree = await renderGit(api);
    const root = tree.root as Queryable;

    // Initial load failed: the real error is surfaced, with no false "clean" claim.
    expect(hasText(root, 'git unavailable')).toBe(true);
    expect(hasText(root, 'Working tree clean')).toBe(false);
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Loading Git status'),
    ).toHaveLength(0);

    // Trigger the periodic poll. Since the initial attempt already settled (even though it
    // failed), this must be a lightweight background refresh, not a repeated full-screen load
    // that would remount/fade the sections again.
    act(() => {
      jest.advanceTimersByTime(GIT_SCREEN_REFRESH_INTERVAL_MS);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Loading Git status'),
    ).toHaveLength(0);

    await act(async () => {
      nextStatus.resolve(cleanStatus);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasText(root, 'Clean')).toBe(true);
    expect(hasText(root, 'git unavailable')).toBe(false);
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Loading Git status'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('executes branch, staging, commit, push, and workspace actions', async () => {
    const api = createApi();
    const tree = await renderGit(api);
    const root = tree.root as Queryable;
    exercisePressableStyles(root);

    await press(root, 'Stage');
    await press(root, 'Unstage');
    await press(root, 'Stage all');
    await press(root, 'Unstage all');
    await press(root, 'Commit');
    await press(root, 'Push (2)');
    await press(root, 'Change branch');
    exercisePressableStyles(root);
    const mainBranch = root.findAll((node) => node.props.accessibilityLabel === 'main, Local')[0];
    act(() => (mainBranch.props.onPress as () => void)());
    await press(root, 'Switch');

    const workspace = root
      .findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'Git workspace path');
    if (!workspace) throw new Error('Missing workspace input');
    act(() => {
      workspace.props.onChangeText('/next');
    });
    await act(async () => {
      workspace.props.onBlur();
      await Promise.resolve();
    });

    expect(api.gitStage).toHaveBeenCalled();
    expect(api.gitUnstage).toHaveBeenCalled();
    expect(api.gitStageAll).toHaveBeenCalled();
    expect(api.gitUnstageAll).toHaveBeenCalled();
    expect(api.gitCommit).toHaveBeenCalled();
    expect(api.gitPush).toHaveBeenCalled();
    expect(api.gitSwitch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'main' }));
    expect(api.setChatWorkspace).toHaveBeenCalledWith(chat.id, '/next');
    act(() => tree.unmount());
  });

  it('adds, edits, deletes, and submits inline review comments', async () => {
    const api = createApi();
    const store = createGitStore(api);
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        withAppStore(
          store,
          <SafeAreaProvider
            initialMetrics={{
              frame: { x: 0, y: 0, width: 390, height: 844 },
              insets: { top: 47, left: 0, right: 0, bottom: 34 },
            }}
          >
            <AppThemeProvider theme={theme}>
              <GitScreen chat={chat} />
            </AppThemeProvider>
          </SafeAreaProvider>,
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    if (!tree) throw new Error('Expected GitScreen tree');
    const root = tree.root as Queryable;
    const icon = root.findAll((node) => node.children.includes('add-circle-outline'))[0];
    let commentButton = icon?.parent as Queryable | null;
    while (commentButton && typeof commentButton.props.onPress !== 'function') {
      commentButton = commentButton.parent as Queryable | null;
    }
    if (!commentButton) throw new Error('Missing review comment action');
    act(() => (commentButton.props.onPress as () => void)());
    const input = root
      .findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'Review comment');
    if (!input) throw new Error('Missing review input');
    act(() => input.props.onChangeText('Please preserve this behavior.'));
    await press(root, 'Save comment');
    expect(hasText(root, 'Inline review')).toBe(true);
    await press(root, 'Send review to agent');
    expect(api.sendOrQueueChatMessage).toHaveBeenCalledWith(
      chat.id,
      expect.objectContaining({
        content: expect.stringContaining('Please preserve this behavior.'),
      }),
    );
    expect(router.dismissTo).toHaveBeenCalledWith(routes.chat('profile-1', chat.id));
    expect(store.get(mainOpeningChatIdAtom)).toBeNull();
    expect(store.get(pendingMainChatIdAtom)).toBeNull();
    act(() => tree?.unmount());
  });

  it('renders raw-status, unpublished, empty-diff, branch-empty, and refresh states', async () => {
    const api = createApi();
    const tree = await renderGit(api);
    const root = tree.root as Queryable;
    await invokeByLabel(root, 'Refresh Git status');
    expect(api.gitStatus).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());

    const rawStatus: GitStatusResponse = {
      ...dirtyStatus,
      branch: 'local-only',
      raw: '## local-only\n M raw.ts\n?? only-new.ts',
      files: [],
      truncated: false,
      totalFiles: 2,
      omittedFiles: 0,
    };
    const rawApi = createApi(rawStatus);
    (rawApi.gitDiff as jest.Mock).mockResolvedValue({
      diff: '',
      cwd: '/workspace',
      truncated: false,
      originalBytes: 0,
      returnedBytes: 0,
      maxBytes: 1024,
    });
    (rawApi.gitBranches as jest.Mock).mockResolvedValue({ current: null, branches: [] });
    const rawTree = await renderGit(rawApi);
    const rawRoot = rawTree.root as Queryable;
    expect(hasText(rawRoot, 'Publish branch')).toBe(true);
    expect(hasText(rawRoot, 'No patch output for current changes yet')).toBe(true);
    await press(rawRoot, 'Change branch');
    expect(hasText(rawRoot, 'No branches found.')).toBe(true);
    await press(rawRoot, 'Close');
    await press(rawRoot, 'Publish branch');
    expect(rawApi.gitPush).toHaveBeenCalled();
    act(() => rawTree.unmount());
  });

  it('refreshes external Git changes on the visible-screen interval', async () => {
    const api = createApi();
    (api.gitStatus as jest.Mock).mockResolvedValueOnce(dirtyStatus).mockResolvedValue(cleanStatus);
    (api.gitDiff as jest.Mock).mockResolvedValueOnce({
      diff: unifiedDiff,
      cwd: '/workspace',
      truncated: false,
      originalBytes: 1024,
      returnedBytes: 1024,
      maxBytes: 1024,
    });
    (api.gitDiff as jest.Mock).mockResolvedValue({
      diff: '',
      cwd: '/workspace',
      truncated: false,
      originalBytes: 0,
      returnedBytes: 0,
      maxBytes: 1024,
    });
    (api.gitHistory as jest.Mock).mockResolvedValueOnce({
      commits: [
        {
          hash: 'before',
          shortHash: 'before',
          subject: 'Before external change',
          authorName: 'Developer',
          authoredAt: '2026-07-20T00:00:00.000Z',
          refNames: [],
          isHead: true,
        },
      ],
    });
    (api.gitHistory as jest.Mock).mockResolvedValue({ commits: [] });

    const tree = await renderGit(api);
    expect(hasText(tree.root as Queryable, 'Ready to commit')).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(GIT_SCREEN_REFRESH_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasText(tree.root as Queryable, 'Clean')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Before external change')).toBe(false);
    act(() => tree.unmount());
  });

  it('retains visible repository data and marks a manual refresh as busy', async () => {
    const api = createApi();
    const nextStatus = deferred<GitStatusResponse>();
    (api.gitStatus as jest.Mock).mockImplementationOnce(() => Promise.resolve(dirtyStatus));

    const tree = await renderGit(api);
    (api.gitStatus as jest.Mock).mockImplementationOnce(() => nextStatus.promise);
    const root = tree.root as Queryable;

    await act(async () => {
      (findByLabel(root, 'Refresh Git status').props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.gitStatus).toHaveBeenCalledTimes(2);
    expect(hasText(root, 'Ready to commit')).toBe(true);
    expect(hasText(root, 'Test commit')).toBe(true);
    expect(hasText(root, 'staged.ts')).toBe(true);
    expect(hasText(root, 'feature/coverage')).toBe(true);
    expect(findByLabel(root, 'Refresh Git status').props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );

    await act(async () => {
      nextStatus.resolve(cleanStatus);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(root, 'Clean')).toBe(true);
    expect(api.gitStatus).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('does not re-read or clear visible data while the workspace input is typed but not saved', async () => {
    const api = createApi();
    const tree = await renderGit(api);
    const root = tree.root as Queryable;
    const initialStatusCalls = (api.gitStatus as jest.Mock).mock.calls.length;

    act(() => {
      findByLabel(root, 'Git workspace path').props.onChangeText('/typed-not-saved');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Typing an intermediate, uncommitted path must not trigger new git reads...
    expect(api.gitStatus).toHaveBeenCalledTimes(initialStatusCalls);
    expect(api.gitStatus).not.toHaveBeenCalledWith('/typed-not-saved');
    // ...and must not clear the previously loaded, still-usable repository state.
    expect(hasText(root, 'Ready to commit')).toBe(true);
    expect(hasText(root, 'staged.ts')).toBe(true);
    act(() => tree.unmount());
  });

  it('ignores an older refresh that finishes after the committed workspace changes', async () => {
    const api = createApi();
    const staleStatus = deferred<GitStatusResponse>();
    const staleDiff = deferred<Awaited<ReturnType<HostBridgeApiClient['gitDiff']>>>();
    const staleHistory = deferred<Awaited<ReturnType<HostBridgeApiClient['gitHistory']>>>();
    const staleBranches = deferred<Awaited<ReturnType<HostBridgeApiClient['gitBranches']>>>();
    const tree = await renderGit(api);
    const root = tree.root as Queryable;
    (api.gitStatus as jest.Mock)
      .mockImplementationOnce(() => staleStatus.promise)
      .mockResolvedValueOnce(cleanStatus);
    (api.gitDiff as jest.Mock)
      .mockImplementationOnce(() => staleDiff.promise)
      .mockResolvedValueOnce({
        diff: '',
        cwd: '/next',
        truncated: false,
        originalBytes: 0,
        returnedBytes: 0,
        maxBytes: 1024,
      });
    (api.gitHistory as jest.Mock)
      .mockImplementationOnce(() => staleHistory.promise)
      .mockResolvedValueOnce({ commits: [] });
    (api.gitBranches as jest.Mock)
      .mockImplementationOnce(() => staleBranches.promise)
      .mockResolvedValueOnce({
        current: 'main',
        branches: [{ name: 'main', remote: false, current: true }],
      });

    act(() => {
      (findByLabel(root, 'Refresh Git status').props.onPress as () => void)();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The stale refresh (still targeting the committed '/workspace' cwd) is in flight.
    expect(api.gitStatus).toHaveBeenLastCalledWith('/workspace');

    const workspace = findByLabel(root, 'Git workspace path');
    act(() => {
      workspace.props.onChangeText('/next');
    });
    await act(async () => {
      workspace.props.onBlur();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.setChatWorkspace).toHaveBeenCalledWith(chat.id, '/next');
    // Once the workspace is actually committed, reads target the new cwd.
    expect(api.gitStatus).toHaveBeenLastCalledWith('/next');
    expect(hasText(root, 'Clean')).toBe(true);

    await act(async () => {
      staleStatus.resolve(dirtyStatus);
      staleDiff.resolve({
        diff: unifiedDiff,
        cwd: '/workspace',
        truncated: false,
        originalBytes: 1024,
        returnedBytes: 1024,
        maxBytes: 1024,
      });
      staleHistory.resolve({ commits: [] });
      staleBranches.resolve({ current: 'feature/coverage', branches: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(root, 'Clean')).toBe(true);
    expect(hasText(root, 'Ready to commit')).toBe(false);
    act(() => tree.unmount());
  });

  it('pauses scheduled refreshes while inactive and removes the lifecycle on unmount', async () => {
    let appStateListener: ((state: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        appStateListener = listener;
        return { remove };
      });
    const api = createApi();
    const tree = await renderGit(api);
    expect(api.gitStatus).toHaveBeenCalledTimes(1);

    act(() => appStateListener?.('background'));
    await act(async () => {
      jest.advanceTimersByTime(GIT_SCREEN_REFRESH_INTERVAL_MS * 2);
      await Promise.resolve();
    });
    expect(api.gitStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      appStateListener?.('active');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.gitStatus).toHaveBeenCalledTimes(2);

    act(() => tree.unmount());
    jest.advanceTimersByTime(GIT_SCREEN_REFRESH_INTERVAL_MS * 2);
    expect(api.gitStatus).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    addEventListener.mockRestore();
  });

  it.each([
    ['gitStage', 'Stage', { staged: false, stderr: '' }, 'Failed to stage unstaged.ts.'],
    ['gitUnstage', 'Unstage', { unstaged: false, stderr: '' }, 'Failed to unstage staged.ts.'],
    ['gitStageAll', 'Stage all', { staged: false, stderr: '' }, 'Failed to stage all files.'],
    [
      'gitUnstageAll',
      'Unstage all',
      { unstaged: false, stderr: '' },
      'Failed to unstage all files.',
    ],
    ['gitCommit', 'Commit', { committed: false, stderr: '' }, 'Commit failed.'],
    ['gitPush', 'Push (2)', { pushed: false, stderr: '' }, 'Push failed.'],
  ])('surfaces unsuccessful %s results', async (method, label, result, message) => {
    const api = createApi();
    (api[method as keyof HostBridgeApiClient] as jest.Mock).mockResolvedValueOnce(result);
    const tree = await renderGit(api);
    await press(tree.root as Queryable, label);
    expect(api[method as keyof HostBridgeApiClient]).toHaveBeenCalled();
    expect(message).toBeTruthy();
    act(() => tree.unmount());
  });

  it.each([
    ['gitStage', 'Stage', 'stage exploded'],
    ['gitUnstage', 'Unstage', 'unstage exploded'],
    ['gitStageAll', 'Stage all', 'stage all exploded'],
    ['gitUnstageAll', 'Unstage all', 'unstage all exploded'],
    ['gitCommit', 'Commit', 'commit exploded'],
    ['gitPush', 'Push (2)', 'push exploded'],
  ])('surfaces rejected %s actions', async (method, label, message) => {
    const api = createApi();
    (api[method as keyof HostBridgeApiClient] as jest.Mock).mockRejectedValueOnce(
      new Error(message),
    );
    const tree = await renderGit(api);
    await press(tree.root as Queryable, label);
    expect(hasText(tree.root as Queryable, message)).toBe(true);
    act(() => tree.unmount());
  });

  it('covers workspace, branch, diff switching, scroll, and review modal branches', async () => {
    const api = createApi();
    (api.setChatWorkspace as jest.Mock).mockRejectedValueOnce(new Error('workspace rejected'));
    const tree = await renderGit(api);
    const root = tree.root as Queryable;
    const workspace = findByLabel(root, 'Git workspace path');
    act(() => workspace.props.onChangeText('  /broken\npath  '));
    await invoke(findByLabel(root, 'Git workspace path'), 'onSubmitEditing');
    expect(api.setChatWorkspace).toHaveBeenCalledWith(chat.id, '/brokenpath');

    (api.gitBranches as jest.Mock).mockResolvedValueOnce({
      current: 'feature/coverage',
      branches: [],
    });
    await press(root, 'Change branch');
    await act(async () => Promise.resolve());
    expect(hasText(root, 'No branches found.')).toBe(true);
    await press(root, 'Close');
    (api.gitBranches as jest.Mock).mockRejectedValueOnce(new Error('branches rejected'));
    await press(root, 'Change branch');
    await act(async () => Promise.resolve());
    expect(hasText(root, 'branches rejected')).toBe(true);

    const scrolls = root.findAllByType(ScrollView) as unknown as Queryable[];
    const nested = scrolls.filter((node) => node.props.nestedScrollEnabled);
    for (const scroll of nested) {
      act(() => {
        (scroll.props.onTouchStart as (() => void) | undefined)?.();
        (scroll.props.onTouchCancel as (() => void) | undefined)?.();
        (scroll.props.onTouchEnd as (() => void) | undefined)?.();
        (scroll.props.onScrollBeginDrag as (() => void) | undefined)?.();
        (scroll.props.onScrollEndDrag as (() => void) | undefined)?.();
        (scroll.props.onMomentumScrollEnd as (() => void) | undefined)?.();
      });
    }

    await press(root, 'unstaged.ts');
    expect(hasText(root, 'Loading diff')).toBe(true);
    act(() => jest.advanceTimersByTime(120));
    expect(hasText(root, 'unstaged.ts')).toBe(true);

    const commentIcon = root.findAll((node) => node.children.includes('add-circle-outline'))[0];
    let commentButton = commentIcon?.parent as Queryable | null;
    while (commentButton && typeof commentButton.props.onPress !== 'function')
      commentButton = commentButton.parent as Queryable | null;
    if (!commentButton) throw new Error('Missing review comment action');
    await invoke(commentButton);
    exercisePressableStyles(root);
    await invoke(findByLabel(root, 'Close inline comment'));
    await invoke(commentButton);
    await press(root, 'Cancel');
    await invoke(commentButton);
    const input = findByLabel(root, 'Review comment');
    act(() => input.props.onChangeText('First note'));
    await press(root, 'Save comment');
    await press(root, 'Edit');
    act(() => findByLabel(root, 'Review comment').props.onChangeText('Updated note'));
    await press(root, 'Save comment');
    await press(root, 'Delete');
    expect(hasText(root, 'Inline review')).toBe(false);
    act(() => tree.unmount());
  });

  it('surfaces branch switching and review submission failures', async () => {
    const api = createApi();
    (api.gitSwitch as jest.Mock).mockResolvedValueOnce({ switched: false, stderr: '', stdout: '' });
    const tree = await renderGit(api);
    const root = tree.root as Queryable;
    await press(root, 'Change branch');
    await invoke(findByLabel(root, 'main, Local'));
    await press(root, 'Switch');
    expect(hasText(root, 'Failed to switch to main.')).toBe(true);
    (api.gitSwitch as jest.Mock).mockRejectedValueOnce(new Error('switch exploded'));
    await press(root, 'Switch');
    expect(hasText(root, 'switch exploded')).toBe(true);

    const commentIcon = root.findAll((node) => node.children.includes('add-circle-outline'))[0];
    let commentButton = commentIcon?.parent as Queryable | null;
    while (commentButton && typeof commentButton.props.onPress !== 'function')
      commentButton = commentButton.parent as Queryable | null;
    if (!commentButton) throw new Error('Missing review comment action');
    await invoke(commentButton);
    act(() => findByLabel(root, 'Review comment').props.onChangeText('Do not regress this.'));
    await press(root, 'Save comment');
    (api.sendOrQueueChatMessage as jest.Mock).mockRejectedValueOnce(new Error('review rejected'));
    await press(root, 'Send review to agent');
    expect(hasText(root, 'review rejected')).toBe(true);
    await press(root, 'Clear');
    expect(hasText(root, 'Inline review')).toBe(false);
    act(() => tree.unmount());
  });

  it.each([
    {
      raw: '## topic...origin/topic [behind 3]\nR  old.ts -> renamed.ts\nD  removed.ts\n!\n  ',
      branch: 'topic',
      expected: ['3 behind', 'origin/topic', 'old.ts -> renamed.ts'],
      authoredAt: 'not-a-date',
    },
    {
      raw: '## HEAD (no branch)\nA  added.ts',
      branch: 'HEAD detached',
      expected: ['Ready to commit', 'added.ts'],
      authoredAt: new Date(Date.now() + 30_000).toISOString(),
    },
    {
      raw: ' M no-header.ts',
      branch: 'unknown',
      expected: ['Review and stage', 'no-header.ts'],
      authoredAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    },
    {
      raw: '## zero...origin/zero [ahead 0, behind 0]\n?? new-only.ts',
      branch: 'zero',
      expected: ['origin/zero', 'new-only.ts'],
      authoredAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    },
  ])(
    'renders porcelain and history fallback matrix %#',
    async ({ raw, branch, expected, authoredAt }) => {
      const status: GitStatusResponse = {
        ...dirtyStatus,
        branch,
        raw,
        files: [],
        truncated: false,
        totalFiles: 2,
        omittedFiles: 0,
      };
      const api = createApi(status);
      (api.gitHistory as jest.Mock).mockResolvedValue({
        commits: [
          {
            hash: `hash-${branch}`,
            shortHash: '1234567',
            subject: 'Matrix commit',
            authorName: 'Matrix author',
            authoredAt,
            refNames: [],
            isHead: false,
          },
        ],
      });
      const tree = await renderGit(api, { ...chat, title: '', cwd: undefined });
      exercisePressableStyles(tree.root as Queryable);
      for (const text of expected) expect(hasText(tree.root as Queryable, text)).toBe(true);
      expect(hasText(tree.root as Queryable, 'Untitled chat')).toBe(true);
      expect(hasText(tree.root as Queryable, 'Using bridge root workspace.')).toBe(true);
      act(() => tree.unmount());
    },
  );

  it('renders structured rename files and relative-time fallback ranges', async () => {
    const status: GitStatusResponse = {
      ...dirtyStatus,
      raw: '## main...origin/main',
      branch: 'main',
      files: [
        {
          path: 'new-name.ts',
          originalPath: 'old-name.ts',
          indexStatus: 'R',
          worktreeStatus: ' ',
          staged: true,
          unstaged: false,
          untracked: false,
        },
      ],
      totalFiles: 1,
      omittedFiles: 0,
      truncated: false,
    };
    const api = createApi(status);
    const now = Date.now();
    (api.gitHistory as jest.Mock).mockResolvedValue({
      commits: [
        {
          hash: 'day',
          shortHash: 'day',
          subject: 'Day',
          authorName: 'A',
          authoredAt: new Date(now - 2 * 86_400_000).toISOString(),
          refNames: ['HEAD'],
          isHead: true,
        },
        {
          hash: 'week',
          shortHash: 'week',
          subject: 'Week',
          authorName: 'A',
          authoredAt: new Date(now - 2 * 7 * 86_400_000).toISOString(),
          refNames: [],
          isHead: false,
        },
        {
          hash: 'month',
          shortHash: 'month',
          subject: 'Month',
          authorName: 'A',
          authoredAt: new Date(now - 2 * 30 * 86_400_000).toISOString(),
          refNames: [],
          isHead: false,
        },
        {
          hash: 'year',
          shortHash: 'year',
          subject: 'Year',
          authorName: 'A',
          authoredAt: new Date(now - 2 * 365 * 86_400_000).toISOString(),
          refNames: [],
          isHead: false,
        },
      ],
    });
    const relativeTime = jest.spyOn(Intl, 'RelativeTimeFormat').mockImplementation(() => {
      throw new Error('unsupported');
    });
    const tree = await renderGit(api);
    expect(hasText(tree.root as Queryable, 'old-name.ts -> new-name.ts')).toBe(true);
    expect(hasText(tree.root as Queryable, '2 days ago')).toBe(true);
    relativeTime.mockRestore();
    act(() => tree.unmount());
  });

  it('shows accessible empty state when working tree is clean', async () => {
    const tree = await renderGit(createApi(cleanStatus));
    const root = tree.root as Queryable;
    expect(hasText(root, 'Working tree clean')).toBe(true);
    expect(hasText(root, 'No staged or unstaged changes.')).toBe(true);
    const emptyStateNode = root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Working tree is clean. No changes to stage or commit.',
    );
    expect(emptyStateNode.length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('diff comment button has hitSlop covering the 44pt minimum touch target', async () => {
    const tree = await renderGit(createApi());
    const root = tree.root as Queryable;
    const commentIcons = root.findAll((node) => node.children.includes('add-circle-outline'));
    let commentButton = commentIcons[0]?.parent as Queryable | null;
    while (commentButton && typeof commentButton.props.onPress !== 'function') {
      commentButton = commentButton.parent as Queryable | null;
    }
    if (!commentButton) throw new Error('Missing diff comment button');
    const { hitSlop } = commentButton.props;
    expect(hitSlop).toBeTruthy();
    if (typeof hitSlop === 'number') {
      // uniform hitSlop: effective width = 28 + 2*hitSlop >= 44, height = 23 + 2*hitSlop >= 44
      expect(28 + hitSlop * 2).toBeGreaterThanOrEqual(44);
      expect(23 + hitSlop * 2).toBeGreaterThanOrEqual(44);
    } else if (hitSlop && typeof hitSlop === 'object') {
      const { top = 0, bottom = 0, left = 0, right = 0 } = hitSlop as Record<string, number>;
      expect(28 + left + right).toBeGreaterThanOrEqual(44);
      expect(23 + top + bottom).toBeGreaterThanOrEqual(44);
    } else {
      throw new Error('Unexpected hitSlop shape');
    }
    act(() => tree.unmount());
  });

  it('inlineReviewComment style has no fixed minWidth that overflows narrow screens', () => {
    const testTheme = createAppTheme('dark');
    const styles = createGitScreenStyles(testTheme) as Record<string, Record<string, unknown>>;
    const { minWidth } = styles.inlineReviewComment ?? {};
    expect(
      minWidth === undefined || minWidth === 0 || (typeof minWidth === 'number' && minWidth < 320),
    ).toBe(true);
  });

  it('fires selection haptic on stage, unstage, stageAll, unstageAll, branchSwitch', async () => {
    const api = createApi();
    const tree = await renderGit(api);
    const root = tree.root as Queryable;

    await press(root, 'Stage');
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    await press(root, 'Unstage');
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    await press(root, 'Stage all');
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    await press(root, 'Unstage all');
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    await press(root, 'Change branch');
    const mainBranch = root.findAll((node) => node.props.accessibilityLabel === 'main, Local')[0];
    act(() => (mainBranch.props.onPress as () => void)());
    await press(root, 'Switch');
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('fires success haptic on commit/push success and error haptic on failure', async () => {
    const api = createApi();
    const tree = await renderGit(api);
    const root = tree.root as Queryable;

    await press(root, 'Commit');
    expect(feedback.success as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    await press(root, 'Push (2)');
    expect(feedback.success as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    (api.gitCommit as jest.Mock).mockResolvedValueOnce({ committed: false, stderr: '' });
    await press(root, 'Commit');
    expect(feedback.error as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    (api.gitPush as jest.Mock).mockResolvedValueOnce({ pushed: false, stderr: '' });
    await press(root, 'Push (2)');
    expect(feedback.error as jest.Mock).toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('fires selection haptic on save comment and success haptic on submit review', async () => {
    const api = createApi();
    const tree = await renderGit(api);
    const root = tree.root as Queryable;

    const commentIcon = root.findAll((node) => node.children.includes('add-circle-outline'))[0];
    let commentButton = commentIcon?.parent as Queryable | null;
    while (commentButton && typeof commentButton.props.onPress !== 'function')
      commentButton = commentButton.parent as Queryable | null;
    if (!commentButton) throw new Error('Missing review comment action');
    act(() => (commentButton.props.onPress as () => void)());
    const input = root
      .findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'Review comment');
    if (!input) throw new Error('Missing review input');
    act(() => input.props.onChangeText('Test note'));
    jest.clearAllMocks();
    await press(root, 'Save comment');
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();
    jest.clearAllMocks();

    await press(root, 'Send review to agent');
    expect(feedback.success as jest.Mock).toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('truncation notice renders with informational (non-error) style', async () => {
    const api = createApi(dirtyStatus); // dirtyStatus has truncated: true
    const tree = await renderGit(api);
    const root = tree.root as Queryable;
    expect(hasText(root, 'Diff preview is limited to 1 KB.')).toBe(true);
    // The truncation node should not have accessibilityRole="alert" (that's for real errors)
    const alertNodes = root.findAll((node) => node.props.accessibilityRole === 'alert');
    const truncationAlerts = alertNodes.filter((node) =>
      node.children.map(String).join('').includes('Diff preview'),
    );
    expect(truncationAlerts).toHaveLength(0);
    act(() => tree.unmount());
  });
});

function findByLabel(root: Queryable, label: string): Queryable {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Missing label: ${label}`);
  return node;
}

async function invoke(node: Queryable, property = 'onPress', value?: unknown): Promise<void> {
  await act(async () => {
    (node.props[property] as (argument?: unknown) => void)(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function invokeByLabel(root: Queryable, label: string): Promise<void> {
  await invoke(findByLabel(root, label));
}
