import { executeGitTool, type GitToolPort } from './gitTools';

function harness() {
  const native = {
    getWorkspaceGitStatus: jest.fn(async () => ({
      branch: 'main',
      clean: false,
      raw: '',
      files: Array.from({ length: 30 }, (_, i) => ({
        path: `${i}.txt`,
        indexStatus: ' ',
        worktreeStatus: 'M',
        staged: false,
        unstaged: true,
        untracked: false,
      })),
      truncated: false,
      totalFiles: 30,
      omittedFiles: 0,
      maxFiles: 200,
      maxBytes: 65536,
      stagedFiles: 0,
      hasOrigin: true,
      origin: 'https://github.com/owner/repository.git',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      detached: false,
      unborn: false,
    })),
    getWorkspaceGitDiff: jest.fn(async () => ({
      diff: 'actual diff',
      truncated: false,
      originalBytes: 11,
      returnedBytes: 11,
      maxBytes: 4096,
    })),
    getWorkspaceGitHistory: jest.fn(async () => ({ commits: [] })),
    stageWorkspaceGit: jest.fn(async () => undefined),
    commitWorkspaceGit: jest.fn(async () => 'actual-hash'),
    pushWorkspaceGit: jest.fn(async () => undefined),
  } satisfies GitToolPort;
  const credentials = jest.fn(async () => 'opaque-reference');
  const author = jest.fn(() => ({ name: 'Author', email: 'author@example.invalid' }));
  const call = (name: string, input: unknown = {}) =>
    executeGitTool('fixed-workspace', name, input, native, author, credentials);
  return { native, author, credentials, call };
}

test('Git tool results are bounded and retain truncation metadata and actual native content', async () => {
  const h = harness();
  const status = await h.call('git_status');
  expect(status).toMatchObject({ totalFiles: 30, omittedFiles: 10, truncated: true, maxFiles: 20 });
  await expect(h.call('git_diff')).resolves.toMatchObject({ diff: 'actual diff' });
  expect(h.native.getWorkspaceGitDiff).toHaveBeenCalledWith('fixed-workspace', 4096);
});

test('mutation dispatch is workspace-bound and never accepts model-supplied credentials or identity', async () => {
  const h = harness();
  await h.call('git_stage', { path: 'literal[1].txt' });
  expect(h.native.stageWorkspaceGit).toHaveBeenCalledWith('fixed-workspace', 'literal[1].txt');
  await h.call('git_commit', { message: 'offline commit' });
  expect(h.native.commitWorkspaceGit).toHaveBeenCalledWith(
    'fixed-workspace',
    'offline commit',
    'Author',
    'author@example.invalid',
  );
  await h.call('git_push');
  expect(h.credentials).toHaveBeenCalledWith('fixed-workspace');
  expect(h.native.pushWorkspaceGit).toHaveBeenCalledWith('fixed-workspace', 'opaque-reference');
  await expect(h.call('git_push', { credential: 'model-value' })).rejects.toThrow();
  await expect(
    h.call('git_commit', { message: 'message', name: 'model-author' }),
  ).rejects.toThrow();
  expect(h.native.pushWorkspaceGit).toHaveBeenCalledTimes(1);
});

test('stage-all and history stay workspace-bound while unavailable tools fail explicitly', async () => {
  const h = harness();
  await expect(h.call('git_stage')).resolves.toEqual({ staged: true, path: null });
  expect(h.native.stageWorkspaceGit).toHaveBeenCalledWith('fixed-workspace', null);
  await expect(h.call('git_history')).resolves.toEqual({ commits: [], truncated: false });
  expect(h.native.getWorkspaceGitHistory).toHaveBeenCalledWith('fixed-workspace');
  await expect(h.call('unavailable_tool')).rejects.toThrow('not available');
  expect(h.native.commitWorkspaceGit).not.toHaveBeenCalled();
  expect(h.native.pushWorkspaceGit).not.toHaveBeenCalled();
});
