import type { GitStatusWithRemote } from '../../workspace/api/protocol';
import { WORKSPACE_HOST_METHODS } from '../../workspace/api/protocol';
import { httpsRemoteError } from '../../workspace/api/remoteUrl';
import type { LocalGitStatus } from '../workspaces/types';
import { LOCAL_RPC_ERROR, LocalRpcError } from './errors';
import type { LocalAgentPort } from './port';
import { readParam, type RpcParams } from './params';

const GIT_OK = { code: 0, stdout: '', stderr: '' };

type ResolveWorkspace = (params: RpcParams) => Promise<{ id: string; cwd: string }>;

function required(params: RpcParams, key: string, message: string): string {
  const value = readParam(params, key);
  if (!value) {
    throw new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, message, { error: 'on_device_failed' });
  }
  return value;
}

function invalid(message: string): LocalRpcError {
  return new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, message, { error: 'on_device_failed' });
}

/** `## main...origin/main [ahead 1, behind 2]`, the header `git status --short --branch` prints. */
function porcelainHeader(status: LocalGitStatus): string {
  const branch = status.unborn
    ? `No commits yet on ${status.branch}`
    : status.detached
      ? 'HEAD (no branch)'
      : status.branch;
  const counts = [
    status.ahead ? `ahead ${String(status.ahead)}` : null,
    status.behind ? `behind ${String(status.behind)}` : null,
  ].filter(Boolean);
  const upstream = status.upstream ? `...${status.upstream}` : '';
  return `## ${branch}${upstream}${counts.length ? ` [${counts.join(', ')}]` : ''}`;
}

/**
 * Shapes native status like the bridge's: untracked files count as unstaged (so they can be
 * staged), `raw` carries the porcelain branch header, and `remote` adds origin and reachability.
 */
export function bridgeGitStatus(
  status: LocalGitStatus,
  network: 'online' | 'offline' | 'unknown',
): GitStatusWithRemote {
  const files = status.files.map((file) => ({
    ...file,
    unstaged: file.unstaged || file.untracked,
  }));
  return {
    branch: status.branch,
    clean: status.clean,
    raw: [porcelainHeader(status), status.raw].filter(Boolean).join('\n'),
    files,
    truncated: status.truncated,
    totalFiles: status.totalFiles,
    omittedFiles: status.omittedFiles,
    maxFiles: status.maxFiles,
    maxBytes: status.maxBytes,
    remote: {
      hasOrigin: status.hasOrigin,
      origin: status.origin,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      detached: status.detached,
      unborn: status.unborn,
      network,
    },
  };
}

/**
 * `bridge/git/*` handlers backed by the native workspace Git services. Responses match the bridge
 * types in `@bridge/types/git` so the shared Git screen renders local workspaces unchanged.
 */
export function createLocalGitHandlers(port: LocalAgentPort, workspace: ResolveWorkspace) {
  return {
    'bridge/git/status': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      return { ...bridgeGitStatus(await port.git.status(id), port.network()), cwd };
    },
    'bridge/git/diff': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      return { ...(await port.git.diff(id)), cwd };
    },
    'bridge/git/history': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const history = await port.git.history(id);
      const limit = typeof params['limit'] === 'number' ? Math.trunc(params['limit']) : null;
      return {
        ...history,
        commits: limit && limit > 0 ? history.commits.slice(0, limit) : history.commits,
        cwd,
      };
    },
    'bridge/git/branches': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const branches = await port.git.branches(id);
      return {
        ...branches,
        current:
          branches.current ?? branches.branches.find((branch) => branch.current)?.name ?? null,
        cwd,
      };
    },
    'bridge/git/stage': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const path = readParam(params, 'path') ?? '';
      await port.git.stage(id, path);
      return { ...GIT_OK, staged: true, path, cwd };
    },
    'bridge/git/stageAll': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      await port.git.stage(id, null);
      return { ...GIT_OK, staged: true, cwd };
    },
    'bridge/git/unstage': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const path = readParam(params, 'path') ?? '';
      await port.git.unstage(id, path);
      return { ...GIT_OK, unstaged: true, path, cwd };
    },
    'bridge/git/unstageAll': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      await port.git.unstage(id, null);
      return { ...GIT_OK, unstaged: true, cwd };
    },
    'bridge/git/commit': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const message = required(params, 'message', 'Enter a commit message.');
      await port.git.commit(id, message);
      return { ...GIT_OK, committed: true, cwd };
    },
    'bridge/git/switch': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const branch = required(params, 'branch', 'Choose a branch.');
      await port.git.switchBranch(id, branch);
      return { ...GIT_OK, switched: true, branch, cwd };
    },
    'bridge/git/push': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      await port.git.push(id);
      return { ...GIT_OK, pushed: true, cwd };
    },
    [WORKSPACE_HOST_METHODS.gitFetch]: async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      await port.git.fetch(id);
      return { fetched: true, cwd };
    },
    [WORKSPACE_HOST_METHODS.gitPull]: async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      return { ...(await port.git.pull(id)), cwd };
    },
    [WORKSPACE_HOST_METHODS.gitInit]: async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const origin = readParam(params, 'origin');
      const originError = origin ? httpsRemoteError(origin) : null;
      if (originError) {
        throw invalid(originError);
      }
      const initialized = await port.git.init(id, readParam(params, 'branch') ?? 'main', origin);
      return { path: cwd, name: initialized.name, isRepository: initialized.isRepository };
    },
    [WORKSPACE_HOST_METHODS.gitDiscard]: async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const path = readParam(params, 'path');
      await port.git.discard(id, path, params['includeUntracked'] === true);
      return { discarded: true, cwd, path };
    },
    [WORKSPACE_HOST_METHODS.gitBranchCreate]: async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      const name = required(params, 'name', 'Enter a branch name.');
      await port.git.createBranch(id, name);
      return { created: true, branch: name, cwd };
    },
  } satisfies Record<string, (params: RpcParams) => Promise<unknown>>;
}
