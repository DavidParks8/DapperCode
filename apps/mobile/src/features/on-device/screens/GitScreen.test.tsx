import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { OnDeviceNativeError } from '../native/services.errors';
import type { LocalGitStatus } from '../workspaces/types';
import { gitRemoteLabel, LocalGitScreen } from './GitScreen';

jest.mock('expo-router', () => ({
  ...jest.requireActual('@shared/testing/expoRouterMock'),
  useLocalSearchParams: () => ({ workspaceId: 'workspace' }),
}));
jest.mock('@shell/layout/useShellLayout', () => ({
  useSceneHorizontalInsets: () => ({ paddingLeft: 0, paddingRight: 0 }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../runtime/OnDeviceProvider', () => ({ useOnDeviceRuntime: () => mockRuntime }));
jest.mock('./GitTransferProgress', () => ({ GitTransferProgress: () => null }));

const baseStatus: LocalGitStatus = {
  branch: 'main',
  clean: false,
  raw: ' M a.txt',
  files: [
    {
      path: 'a.txt',
      originalPath: null,
      indexStatus: ' ',
      worktreeStatus: 'M',
      staged: false,
      unstaged: true,
      untracked: false,
    },
  ],
  truncated: false,
  totalFiles: 1,
  omittedFiles: 0,
  maxFiles: 500,
  maxBytes: 524288,
  stagedFiles: 0,
  hasOrigin: false,
  origin: null,
  upstream: null,
  ahead: null,
  behind: null,
  detached: false,
  unborn: false,
};

const mockRuntime = {
  preferences: () => ({ workspaceId: 'workspace', author: { name: 'A', email: 'a@b.c' } }),
  workspaces: () => [{ id: 'workspace', name: 'Workspace', isRepository: true }],
  workspaceBusy: () => false,
  workspaceTask: <T,>(_label: string, action: () => Promise<T>) => action(),
  refreshWorkspaces: jest.fn(async () => undefined),
  credential: jest.fn(async () => null),
  native: {
    getWorkspaceGitStatus: jest.fn<Promise<LocalGitStatus>, [string]>(),
    getWorkspaceGitDiff: jest.fn(async () => ({
      diff: '',
      truncated: false,
      originalBytes: 0,
      returnedBytes: 0,
      maxBytes: 0,
    })),
    getWorkspaceGitHistory: jest.fn(async () => ({ commits: [] })),
    getWorkspaceGitBranches: jest.fn(async () => ({ branches: [], current: 'main' })),
    initWorkspaceGit: jest.fn(async () => ({ id: 'workspace', name: 'W', isRepository: true })),
    pullWorkspaceGit: jest.fn(async () => ({
      outcome: 'fast-forwarded' as const,
      from: 'a',
      to: 'abcdef1234',
    })),
    pushWorkspaceGit: jest.fn(async () => undefined),
  },
};

const isDisabled = (title: string) =>
  (
    screen.getByRole('button', { name: title }).props['accessibilityState'] as {
      disabled?: boolean;
    }
  ).disabled === true;

beforeEach(() => {
  jest.clearAllMocks();
});

test('a workspace without Git shows a typed initialize state instead of a raw native error', async () => {
  mockRuntime.native.getWorkspaceGitStatus
    .mockRejectedValueOnce(
      new OnDeviceNativeError('GIT_NOT_REPOSITORY', 'This workspace is not a Git repository.'),
    )
    .mockResolvedValueOnce(baseStatus);
  render(<LocalGitScreen />);
  expect(await screen.findByText('Not a Git repository')).toBeTruthy();
  expect(screen.queryByText(/Exception|not a Git repository\./)).toBeNull();
  fireEvent.changeText(
    screen.getByLabelText('Origin URL (optional)'),
    ' https://github.com/o/r.git ',
  );
  fireEvent.press(screen.getByText('Initialize Git'));
  await waitFor(() =>
    expect(mockRuntime.native.initWorkspaceGit).toHaveBeenCalledWith(
      'workspace',
      'main',
      'https://github.com/o/r.git',
    ),
  );
  expect(await screen.findByText('main · 1 changed files')).toBeTruthy();
  expect(screen.queryByText('Not a Git repository')).toBeNull();
  expect(mockRuntime.refreshWorkspaces).toHaveBeenCalled();
});

test('push, fetch, pull, and commit are disabled when there is no remote or nothing staged', async () => {
  mockRuntime.native.getWorkspaceGitStatus.mockResolvedValue(baseStatus);
  render(<LocalGitScreen />);
  expect(await screen.findByText(/No origin remote/)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Commit message'), 'message');
  expect(isDisabled('Push current branch')).toBe(true);
  expect(isDisabled('Fetch from origin')).toBe(true);
  expect(isDisabled('Pull (fast-forward only)')).toBe(true);
  expect(isDisabled('Commit staged changes')).toBe(true);
});

test('ahead/behind counts are shown and pull reports its fast-forward', async () => {
  mockRuntime.native.getWorkspaceGitStatus.mockResolvedValue({
    ...baseStatus,
    stagedFiles: 1,
    hasOrigin: true,
    origin: 'https://github.com/o/r.git',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  });
  render(<LocalGitScreen />);
  expect(await screen.findByText('2 ahead, 1 behind origin/main.')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Commit message'), 'message');
  expect(isDisabled('Push current branch')).toBe(false);
  expect(isDisabled('Commit staged changes')).toBe(false);
  fireEvent.press(screen.getByText('Pull (fast-forward only)'));
  expect(await screen.findByText('Fast-forwarded to abcdef1.')).toBeTruthy();
  expect(mockRuntime.native.pullWorkspaceGit).toHaveBeenCalledWith('workspace', null);
});

test('remote labels cover detached, unpublished, and synchronized branches', () => {
  const remote = { ...baseStatus, hasOrigin: true, origin: 'https://x/y.git' };
  expect(gitRemoteLabel({ ...remote, detached: true })).toMatch(/Detached HEAD/);
  expect(gitRemoteLabel(remote)).toMatch(/No upstream branch yet/);
  expect(gitRemoteLabel({ ...remote, upstream: 'origin/main', ahead: 0, behind: 0 })).toBe(
    'Up to date with origin/main.',
  );
});
