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

/**
 * `bridge/git/*` handlers backed by the native workspace Git services. Responses match the bridge
 * types in `@bridge/types/git` so the shared Git screen renders local workspaces unchanged.
 */
export function createLocalGitHandlers(port: LocalAgentPort, workspace: ResolveWorkspace) {
  return {
    'bridge/git/status': async (params: RpcParams) => {
      const { id, cwd } = await workspace(params);
      return { ...(await port.git.status(id)), cwd };
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
  } satisfies Record<string, (params: RpcParams) => Promise<unknown>>;
}
