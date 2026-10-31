import type { GitStatusWithRemote } from '../../workspace/api/protocol';
import { OnDeviceNativeError } from '../native/services.errors';
import type { LocalGitStatus } from '../workspaces/types';
import { LocalBridgeServer, LocalRpcError } from './server';
import { FakeAgentPort } from './testing';
import { LOCAL_WORKSPACE_ROOT } from './wire';
import { LOCAL_FILE_READ_LIMIT } from './workspaceHandlers';

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;

function setup() {
  const port = new FakeAgentPort();
  const server = new LocalBridgeServer(port);
  server.start();
  return { port, server };
}

async function rpcError(promise: Promise<unknown>): Promise<LocalRpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LocalRpcError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the request to fail');
}

function localStatus(overrides: Partial<LocalGitStatus> = {}): LocalGitStatus {
  return {
    branch: 'main',
    clean: false,
    raw: '?? NOTES.md\n M README.md',
    files: [
      {
        path: 'NOTES.md',
        indexStatus: '?',
        worktreeStatus: '?',
        staged: false,
        unstaged: false,
        untracked: true,
      },
      {
        path: 'README.md',
        indexStatus: ' ',
        worktreeStatus: 'M',
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    truncated: false,
    totalFiles: 2,
    omittedFiles: 0,
    maxFiles: 500,
    maxBytes: 1_000_000,
    stagedFiles: 0,
    hasOrigin: true,
    origin: 'https://github.com/acme/demo.git',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
    detached: false,
    unborn: false,
    ...overrides,
  };
}

describe('LocalBridgeServer Git status', () => {
  it('lets untracked files be staged and reports remote tracking like the bridge', async () => {
    const { port, server } = setup();
    port.git.status = () => Promise.resolve(localStatus());
    port.networkValue = 'offline';
    const status = (await server.request('bridge/git/status', {
      cwd: DEMO,
    })) as GitStatusWithRemote;

    // Native status marks untracked files as not unstaged, which hid their Stage button.
    expect(status.files.find((file) => file.path === 'NOTES.md')).toMatchObject({
      untracked: true,
      unstaged: true,
    });
    expect(status.raw.split('\n')[0]).toBe('## main...origin/main [ahead 2, behind 1]');
    expect(status.remote).toEqual({
      hasOrigin: true,
      origin: 'https://github.com/acme/demo.git',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      detached: false,
      unborn: false,
      network: 'offline',
    });
    expect(status).not.toHaveProperty('stagedFiles');
  });

  it('describes repositories without an origin, upstream, or commits', async () => {
    const { port, server } = setup();
    port.git.status = () =>
      Promise.resolve(
        localStatus({
          hasOrigin: false,
          origin: null,
          upstream: null,
          ahead: null,
          behind: null,
          unborn: true,
        }),
      );
    const status = (await server.request('bridge/git/status', {
      cwd: DEMO,
    })) as GitStatusWithRemote;
    expect(status.raw.split('\n')[0]).toBe('## No commits yet on main');
    expect(status.remote).toMatchObject({ hasOrigin: false, upstream: null, unborn: true });
  });

  it('reports workspaces without Git as a typed not-repository failure', async () => {
    const { port, server } = setup();
    port.git.status = () =>
      Promise.reject(new OnDeviceNativeError('GIT_NOT_REPOSITORY', 'Not a repository.'));
    const error = await rpcError(server.request('bridge/git/status', { cwd: DEMO }));
    expect(error.data).toEqual({
      error: 'on_device_not_repository',
      nativeCode: 'GIT_NOT_REPOSITORY',
    });
  });
});

describe('LocalBridgeServer Git extensions', () => {
  it('fetches, fast-forwards, discards, creates branches, and initializes Git', async () => {
    const { port, server } = setup();
    await expect(server.request('workspace/git/fetch', { cwd: DEMO })).resolves.toEqual({
      fetched: true,
      cwd: DEMO,
    });
    await expect(server.request('workspace/git/pull', { cwd: DEMO })).resolves.toEqual({
      outcome: 'fast-forwarded',
      from: 'aaaaaaa',
      to: 'bbbbbbbbbb',
      cwd: DEMO,
    });
    await server.request('workspace/git/discard', {
      cwd: DEMO,
      path: 'README.md',
      includeUntracked: true,
    });
    await server.request('workspace/git/discard', { cwd: DEMO, path: null });
    await server.request('workspace/git/branch/create', { cwd: DEMO, name: 'feature/x' });
    await expect(
      server.request('workspace/git/init', {
        cwd: DEMO,
        branch: 'main',
        origin: 'https://github.com/acme/demo.git',
      }),
    ).resolves.toEqual({ path: DEMO, name: 'Demo', isRepository: true });
    expect(port.calls.filter((call) => call.startsWith('git.'))).toEqual([
      'git.fetch:["ws-one"]',
      'git.pull:["ws-one"]',
      'git.discard:["ws-one","README.md",true]',
      'git.discard:["ws-one",null,false]',
      'git.createBranch:["ws-one","feature/x"]',
      'git.init:["ws-one","main","https://github.com/acme/demo.git"]',
    ]);
  });

  it('rejects SSH and malformed origins before touching native Git', async () => {
    const { port, server } = setup();
    const ssh = await rpcError(
      server.request('workspace/git/init', { cwd: DEMO, origin: 'git@github.com:acme/demo.git' }),
    );
    expect(ssh.message).toMatch(/HTTPS URL/u);
    const malformed = await rpcError(
      server.request('workspace/git/init', { cwd: DEMO, origin: 'not a url' }),
    );
    expect(malformed.message).not.toMatch(/Invalid URL/u);
    expect(port.calls.some((call) => call.startsWith('git.init'))).toBe(false);
  });

  it('requires a branch name', async () => {
    const { server } = setup();
    const error = await rpcError(server.request('workspace/git/branch/create', { cwd: DEMO }));
    expect(error.message).toBe('Enter a branch name.');
  });
});

describe('LocalBridgeServer workspaces', () => {
  it('clones HTTPS remotes into a new workspace named by the caller', async () => {
    const { port, server } = setup();
    const result = await server.request('bridge/git/clone', {
      url: 'https://github.com/acme/tool.git',
      parentPath: LOCAL_WORKSPACE_ROOT,
      directoryName: 'tool',
    });
    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
      cloned: true,
      cwd: `${LOCAL_WORKSPACE_ROOT}/tool`,
      url: 'https://github.com/acme/tool.git',
    });
    expect(port.calls).toContain('workspace.clone:tool:https://github.com/acme/tool.git');
  });

  it.each([
    ['git@github.com:acme/tool.git', /HTTPS URL/u],
    ['http://github.com/acme/tool.git', /https:\/\//u],
    ['github.com/acme/tool', /full URL/u],
    ['https://github.com', /repository path/u],
  ])('rejects the clone URL %s with guidance', async (url, message) => {
    const { port, server } = setup();
    const error = await rpcError(
      server.request('bridge/git/clone', { url, directoryName: 'tool' }),
    );
    expect(error.message).toMatch(message);
    expect(port.calls.some((call) => call.startsWith('workspace.clone'))).toBe(false);
  });

  it('only clones into the On this iPhone root', async () => {
    const { server } = setup();
    const error = await rpcError(
      server.request('bridge/git/clone', {
        url: 'https://github.com/acme/tool.git',
        parentPath: DEMO,
        directoryName: 'tool',
      }),
    );
    expect(error.message).toMatch(/own workspace/u);
  });

  it('cancels and reports clone progress', async () => {
    const { port, server } = setup();
    await expect(server.request('workspace/clone/progress', {})).resolves.toEqual({
      active: false,
      cancelled: false,
      completed: 0,
      total: 0,
    });
    await server.request('workspace/clone/cancel', {});
    expect(port.calls).toContain('workspace.cancelTransfer');
  });

  it('creates, renames, and deletes workspaces by presented path', async () => {
    const { port, server } = setup();
    await expect(server.request('workspace/create', { name: 'Scratch' })).resolves.toEqual({
      path: `${LOCAL_WORKSPACE_ROOT}/Scratch`,
      name: 'Scratch',
      isRepository: false,
    });
    await expect(
      server.request('workspace/rename', { cwd: `${LOCAL_WORKSPACE_ROOT}/Scratch`, name: 'Notes' }),
    ).resolves.toMatchObject({ path: `${LOCAL_WORKSPACE_ROOT}/Notes`, name: 'Notes' });
    await server.request('workspace/delete', { cwd: `${LOCAL_WORKSPACE_ROOT}/Notes` });
    expect(port.workspaceList.map((workspace) => workspace.name)).toEqual(['Demo']);
  });

  it('lists workspaces with Git branch and origin metadata', async () => {
    const { port, server } = setup();
    port.workspaceList = [
      { id: 'ws-two', name: 'scratch', isRepository: false },
      { id: 'ws-one', name: 'Demo', isRepository: true },
    ];
    await expect(server.request('workspace/list', {})).resolves.toEqual({
      workspaces: [
        {
          path: DEMO,
          name: 'Demo',
          isRepository: true,
          branch: 'main',
          origin: 'https://github.com/acme/demo.git',
        },
        {
          path: `${LOCAL_WORKSPACE_ROOT}/scratch`,
          name: 'scratch',
          isRepository: false,
          branch: null,
          origin: null,
        },
      ],
    });
    expect(port.calls).toContain('refreshWorkspaces');
  });
});

describe('LocalBridgeServer files', () => {
  it('lists folders with workspace-relative paths', async () => {
    const { port, server } = setup();
    port.fileMap.set('ws-one:src/app.ts', 'export {};\n');
    port.fileMap.set('ws-one:README.md', '# Demo\n');
    await expect(
      server.request('workspace/files/list', { cwd: DEMO, path: '' }),
    ).resolves.toMatchObject({
      cwd: DEMO,
      path: '',
      entries: [
        { name: 'src', path: 'src', kind: 'directory' },
        { name: 'README.md', path: 'README.md', kind: 'file', bytes: 7 },
      ],
    });
    await expect(
      server.request('workspace/files/list', { cwd: DEMO, path: '/src/' }),
    ).resolves.toMatchObject({ path: 'src', entries: [{ name: 'app.ts', path: 'src/app.ts' }] });
  });

  it('reads large files as a truncated preview with their total size', async () => {
    const { port, server } = setup();
    port.fileMap.set('ws-one:big.txt', 'x'.repeat(LOCAL_FILE_READ_LIMIT + 10));
    await expect(
      server.request('workspace/files/read', { cwd: DEMO, path: 'big.txt' }),
    ).resolves.toMatchObject({ truncated: true, totalBytes: LOCAL_FILE_READ_LIMIT + 10 });
  });

  it('creates files without replacing existing ones and saves with the read revision', async () => {
    const { port, server } = setup();
    await expect(
      server.request('workspace/files/create', { cwd: DEMO, path: 'docs/new.md' }),
    ).resolves.toEqual({ path: 'docs/new.md', revision: 'rev-0' });
    const exists = await rpcError(
      server.request('workspace/files/create', { cwd: DEMO, path: 'docs/new.md' }),
    );
    expect(exists.data).toMatchObject({ nativeCode: 'PATH_EXISTS' });
    await expect(
      server.request('workspace/files/write', {
        cwd: DEMO,
        path: 'docs/new.md',
        content: 'hello',
        revision: 'rev-0',
      }),
    ).resolves.toEqual({ path: 'docs/new.md', revision: 'rev-5' });
    const unread = await rpcError(
      server.request('workspace/files/write', { cwd: DEMO, path: 'docs/new.md', content: 'x' }),
    );
    expect(unread.message).toBe('Open the file before saving it.');
    expect(port.fileMap.get('ws-one:docs/new.md')).toBe('hello');
  });

  it('renames and removes entries but never the workspace root', async () => {
    const { port, server } = setup();
    port.fileMap.set('ws-one:a.txt', 'a');
    await server.request('workspace/files/rename', {
      cwd: DEMO,
      path: 'a.txt',
      destination: 'b.txt',
    });
    await server.request('workspace/files/remove', { cwd: DEMO, path: 'b.txt' });
    expect([...port.fileMap.keys()]).toEqual([]);
    const root = await rpcError(server.request('workspace/files/remove', { cwd: DEMO, path: '' }));
    expect(root.message).toMatch(/cannot be deleted/u);
  });

  it('exposes the workspace change token', async () => {
    const { server } = setup();
    await expect(server.request('workspace/changeToken', { cwd: DEMO })).resolves.toEqual({
      token: 'token-ws-one-0',
    });
  });

  it('rejects file requests without a workspace instead of a raw native error', async () => {
    const { server } = setup();
    const error = await rpcError(server.request('workspace/files/list', { path: '' }));
    expect(error.data).toEqual({ error: 'on_device_workspace_required' });
    expect(error.message).toBe('Choose a workspace on this iPhone first.');
  });
});
