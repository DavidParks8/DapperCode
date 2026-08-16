import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { ApprovalMode, Chat, GitStatusResponse } from '@bridge/types/types';
import {
  GIT_SCREEN_REFRESH_INTERVAL_MS,
  gitErrorMessage,
  type GitScreenController,
  useGitScreenController,
} from './screenController';

const chat: Chat = {
  id: 'thread-1',
  title: 'Repository chat',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: '',
  cwd: '/committed',
  messages: [],
};

function statusFor(cwd: string, overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: 'main',
    clean: false,
    raw: `## main\nM  ${cwd}/staged.ts`,
    files: [
      {
        path: 'staged.ts',
        indexStatus: 'M',
        worktreeStatus: ' ',
        staged: true,
        unstaged: false,
        untracked: false,
      },
    ],
    cwd,
    truncated: false,
    totalFiles: 1,
    omittedFiles: 0,
    maxFiles: 10,
    maxBytes: 1024,
    ...overrides,
  };
}

function createApi() {
  const methods: Record<string, jest.Mock> = {
    gitStatus: jest
      .fn()
      .mockImplementation((cwd?: string) => Promise.resolve(statusFor(cwd ?? ''))),
    gitDiff: jest.fn().mockImplementation((cwd?: string) =>
      Promise.resolve({
        diff: '',
        cwd,
        truncated: false,
        originalBytes: 0,
        returnedBytes: 0,
        maxBytes: 1024,
      }),
    ),
    gitHistory: jest.fn().mockResolvedValue({ commits: [] }),
    gitBranches: jest.fn().mockResolvedValue({
      current: 'main',
      branches: [{ name: 'main', remote: false, current: true }],
    }),
    gitCommit: jest.fn().mockResolvedValue({ committed: true, stderr: '' }),
    gitPush: jest.fn().mockResolvedValue({ pushed: true, stderr: '' }),
    gitSwitch: jest.fn().mockResolvedValue({ switched: true, stderr: '', stdout: '' }),
    gitStage: jest.fn().mockResolvedValue({ staged: true, stderr: '' }),
    gitUnstage: jest.fn().mockResolvedValue({ unstaged: true, stderr: '' }),
    gitStageAll: jest.fn().mockResolvedValue({ staged: true, stderr: '' }),
    gitUnstageAll: jest.fn().mockResolvedValue({ unstaged: true, stderr: '' }),
    setChatWorkspace: jest.fn(),
  };
  return methods as unknown as HostBridgeApiClient;
}

function makeHarness(
  api: HostBridgeApiClient,
  initialChat: Chat = chat,
  approvalMode?: ApprovalMode,
) {
  let current: GitScreenController;
  const onChatUpdated = jest.fn();
  function Probe(props: { chat: Chat }) {
    current = useGitScreenController({
      api,
      chat: props.chat,
      approvalMode,
      onBack: jest.fn(),
      onChatUpdated,
    });
    return null;
  }
  let tree: ReactTestRenderer;
  return {
    onChatUpdated,
    get current() {
      return current!;
    },
    async mount() {
      await act(async () => {
        tree = renderer.create(React.createElement(Probe, { chat: initialChat }));
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async flush() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    unmount() {
      act(() => tree!.unmount());
    },
  };
}

describe('useGitScreenController committed cwd handling', () => {
  it('normalizes branch-loading rejection values', () => {
    expect(gitErrorMessage(new Error('offline'), 'Could not load branches.')).toBe('offline');
    expect(gitErrorMessage('offline', 'Could not load branches.')).toBe('Could not load branches.');
  });

  describe('useGitScreenController maintenance polling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('pauses refreshes in the background and resumes one polling loop in the foreground', async () => {
      let appStateListener: ((state: AppStateStatus) => void) | null = null;
      const appStateSpy = jest
        .spyOn(AppState, 'addEventListener')
        .mockImplementation((_event, listener) => {
          appStateListener = listener;
          return { remove: jest.fn() };
        });
      const api = createApi();
      const harness = makeHarness(api);

      await harness.mount();
      const initialRefreshCount = (api.gitStatus as jest.Mock).mock.calls.length;

      act(() => {
        appStateListener?.('background');
        jest.advanceTimersByTime(GIT_SCREEN_REFRESH_INTERVAL_MS * 2);
      });
      expect(api.gitStatus).toHaveBeenCalledTimes(initialRefreshCount);

      act(() => {
        appStateListener?.('active');
      });
      await harness.flush();
      expect(api.gitStatus).toHaveBeenCalledTimes(initialRefreshCount + 1);

      act(() => {
        jest.advanceTimersByTime(GIT_SCREEN_REFRESH_INTERVAL_MS);
      });
      await harness.flush();
      expect(api.gitStatus).toHaveBeenCalledTimes(initialRefreshCount + 2);

      harness.unmount();
      appStateSpy.mockRestore();
    });
  });

  it('reads only the committed activeChat.cwd on initial load, ignoring the seeded draft text', async () => {
    const api = createApi();
    const harness = makeHarness(api);
    await harness.mount();

    expect(api.gitStatus).toHaveBeenCalledWith('/committed');
    expect(api.gitDiff).toHaveBeenCalledWith('/committed');
    expect(api.gitHistory).toHaveBeenCalledWith('/committed', 12);
    expect(harness.current.requestedCwd).toBe('/committed');
    harness.unmount();
  });

  it('does not re-read or clear visible state while the workspace input is typed but not committed', async () => {
    const api = createApi();
    const harness = makeHarness(api);
    await harness.mount();

    const initialStatusCalls = (api.gitStatus as jest.Mock).mock.calls.length;
    const initialDiffCalls = (api.gitDiff as jest.Mock).mock.calls.length;
    expect(harness.current.status?.cwd).toBe('/committed');

    // Simulate the user typing an intermediate, uncommitted path character by character.
    act(() => harness.current.setWorkspaceDraft('/typ'));
    await harness.flush();
    act(() => harness.current.setWorkspaceDraft('/typed-not-saved'));
    await harness.flush();

    // No additional git reads should have been issued for the typed draft.
    expect((api.gitStatus as jest.Mock).mock.calls.length).toBe(initialStatusCalls);
    expect((api.gitDiff as jest.Mock).mock.calls.length).toBe(initialDiffCalls);
    // requestedCwd (used for reads/mutations) must stay on the committed cwd.
    expect(harness.current.requestedCwd).toBe('/committed');
    // Previously loaded, still-usable status must remain visible, not cleared.
    expect(harness.current.status?.cwd).toBe('/committed');
    expect(harness.current.loading).toBe(false);
    harness.unmount();
  });

  it('targets the committed cwd for mutation commands even while an uncommitted draft differs', async () => {
    const api = createApi();
    const harness = makeHarness(api);
    await harness.mount();

    act(() => harness.current.setWorkspaceDraft('/typed-not-saved'));
    await harness.flush();

    await act(async () => {
      harness.current.setCommitMessage('chore: checkpoint');
      await harness.current.commit();
    });
    expect(api.gitCommit).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/committed' }));

    await act(async () => {
      await harness.current.push();
    });
    expect(api.gitPush).toHaveBeenCalledWith('/committed');

    await act(async () => {
      await harness.current.stageFile('staged.ts');
    });
    expect(api.gitStage).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'staged.ts', cwd: '/committed' }),
    );

    await act(async () => {
      await harness.current.switchBranch('main');
    });
    expect(api.gitSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'main', cwd: '/committed' }),
    );

    harness.unmount();
  });

  it('switches reads and mutations to the newly committed cwd once the workspace is saved', async () => {
    const api = createApi();
    (api.setChatWorkspace as jest.Mock).mockResolvedValue({ ...chat, cwd: '/next' });
    const harness = makeHarness(api, chat, 'none');
    await harness.mount();

    act(() => harness.current.setWorkspaceDraft('/next'));
    await harness.flush();
    // Still uncommitted: no read against '/next' yet.
    expect(api.gitStatus).not.toHaveBeenCalledWith('/next');

    await act(async () => {
      await harness.current.commitWorkspaceIfChanged();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.setChatWorkspace).toHaveBeenCalledWith(chat.id, '/next', 'never');
    expect(harness.current.requestedCwd).toBe('/next');
    expect(api.gitStatus).toHaveBeenCalledWith('/next');

    await act(async () => {
      await harness.current.push();
    });
    expect(api.gitPush).toHaveBeenLastCalledWith('/next');

    harness.unmount();
  });

  it('ignores a stale in-flight read for the previously committed cwd after the workspace changes', async () => {
    const api = createApi();
    let resolveStale!: (value: GitStatusResponse) => void;
    (api.gitStatus as jest.Mock)
      .mockImplementationOnce(() => Promise.resolve(statusFor('/committed')))
      .mockImplementationOnce(
        () =>
          new Promise<GitStatusResponse>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(statusFor('/next', { clean: true })));
    (api.setChatWorkspace as jest.Mock).mockResolvedValue({ ...chat, cwd: '/next' });

    const harness = makeHarness(api);
    await harness.mount();

    // Kick off a manual refresh against the still-committed '/committed' cwd; it will hang.
    act(() => {
      void harness.current.refresh();
    });
    await harness.flush();

    // Commit a new workspace while the previous read is still in flight.
    act(() => harness.current.setWorkspaceDraft('/next'));
    await act(async () => {
      await harness.current.commitWorkspaceIfChanged();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.current.requestedCwd).toBe('/next');
    expect(harness.current.status?.cwd).toBe('/next');
    expect(harness.current.status?.clean).toBe(true);

    // Now resolve the stale '/committed' read; it must be discarded, not override '/next'.
    await act(async () => {
      resolveStale(statusFor('/committed', { clean: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.current.status?.cwd).toBe('/next');
    expect(harness.current.status?.clean).toBe(true);
    harness.unmount();
  });
});

describe('useGitScreenController rejected gitStatus handling', () => {
  it('settles the initial load on failure: status stays null, error is set, and loading clears', async () => {
    const api = createApi();
    (api.gitStatus as jest.Mock).mockRejectedValueOnce(new Error('git status failed'));
    const harness = makeHarness(api);
    await harness.mount();

    expect(harness.current.status).toBeNull();
    expect(harness.current.error).toBe('git status failed');
    expect(harness.current.loading).toBe(false);
    harness.unmount();
  });

  it('treats a manual refresh after a failed initial load as a background refresh, not a repeated initial spinner', async () => {
    const api = createApi();
    (api.gitStatus as jest.Mock)
      .mockRejectedValueOnce(new Error('git status failed'))
      .mockImplementationOnce(() => Promise.resolve(statusFor('/committed')));
    const harness = makeHarness(api);
    await harness.mount();

    expect(harness.current.status).toBeNull();
    expect(harness.current.error).toBe('git status failed');
    expect(harness.current.loading).toBe(false);

    // A subsequent refresh attempt (e.g. the periodic poll or a manual retry) must not
    // re-trigger the full-screen "loading" state; it should use the lightweight "refreshing"
    // treatment because the initial load already settled (even though it failed).
    let sawLoadingDuringRetry = false;
    await act(async () => {
      const retry = harness.current.refresh();
      // loading must not flip back to true synchronously when the retry starts.
      sawLoadingDuringRetry = harness.current.loading;
      await retry;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sawLoadingDuringRetry).toBe(false);
    expect(harness.current.loading).toBe(false);
    expect(harness.current.error).toBeNull();
    expect(harness.current.status?.cwd).toBe('/committed');
    harness.unmount();
  });
});
