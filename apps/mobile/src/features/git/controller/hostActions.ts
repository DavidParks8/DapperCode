import { useCallback, useState } from 'react';

import { feedback } from '@shared/feedback';
import type { ActiveProfileFeatures } from '@shell/state/bridge/atoms';
import type { WorkspaceHostClient } from '../../workspace/api/client';
import { describeHostError } from '../../workspace/api/errors';
import { httpsRemoteError } from '../../workspace/api/remoteUrl';

/** Host affordances the Git screen offers beyond the bridge contract. */
export type GitHostFeatures = Pick<
  ActiveProfileFeatures,
  'gitSync' | 'gitDiscard' | 'gitBranchCreate' | 'gitInit' | 'workspaceFiles' | 'managedWorkspaces'
>;

export const NO_GIT_HOST_FEATURES: GitHostFeatures = {
  gitSync: false,
  gitDiscard: false,
  gitBranchCreate: false,
  gitInit: false,
  workspaceFiles: false,
  managedWorkspaces: false,
};

interface UseGitHostActionsArgs {
  host: WorkspaceHostClient | null;
  features: GitHostFeatures;
  requestedCwd: string | undefined;
  refresh: () => Promise<void>;
  setError: (error: string | null) => void;
}

export type GitSyncOperation = 'fetch' | 'pull';

/**
 * Fetch, pull, discard, branch creation, and repository setup, available when the host
 * advertises them. Each action refreshes the screen and reports typed failures as friendly copy.
 */
export function useGitHostActions({
  host,
  features,
  requestedCwd,
  refresh,
  setError,
}: UseGitHostActionsArgs) {
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<GitSyncOperation | null>(null);
  const [discardingPath, setDiscardingPath] = useState<string | null>(null);
  const [discardingAll, setDiscardingAll] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [initOrigin, setInitOrigin] = useState('');

  const run = useCallback(
    async (
      begin: () => void,
      end: () => void,
      fallback: string,
      action: (client: WorkspaceHostClient, cwd: string) => Promise<string | null>,
    ): Promise<boolean> => {
      if (!host || !requestedCwd) {
        return false;
      }
      begin();
      setNotice(null);
      try {
        const message = await action(host, requestedCwd);
        void feedback.success();
        setError(null);
        setNotice(message);
        await refresh();
        return true;
      } catch (error) {
        void feedback.error();
        // Refresh first: a successful refresh clears the screen error.
        await refresh().catch(() => undefined);
        setError(describeHostError(error, fallback));
        return false;
      } finally {
        end();
      }
    },
    [host, refresh, requestedCwd, setError],
  );

  const fetch = useCallback(
    () =>
      run(
        () => setSyncing('fetch'),
        () => setSyncing(null),
        'Fetch failed.',
        async (client, cwd) => {
          await client.gitFetch(cwd);
          return 'Fetched the latest changes from origin.';
        },
      ),
    [run],
  );

  const pull = useCallback(
    () =>
      run(
        () => setSyncing('pull'),
        () => setSyncing(null),
        'Pull failed.',
        async (client, cwd) => {
          const result = await client.gitPull(cwd);
          return result.outcome === 'up-to-date'
            ? 'Already up to date.'
            : `Fast-forwarded to ${result.to.slice(0, 7)}.`;
        },
      ),
    [run],
  );

  const discardFile = useCallback(
    (path: string) =>
      run(
        () => setDiscardingPath(path),
        () => setDiscardingPath((current) => (current === path ? null : current)),
        `Could not discard changes to ${path}.`,
        async (client, cwd) => {
          await client.gitDiscard(cwd, path, true);
          return `Discarded changes to ${path}.`;
        },
      ),
    [run],
  );

  const discardAll = useCallback(
    () =>
      run(
        () => setDiscardingAll(true),
        () => setDiscardingAll(false),
        'Could not discard changes.',
        async (client, cwd) => {
          await client.gitDiscard(cwd, null, true);
          return 'Discarded all unstaged changes. Staged changes were kept.';
        },
      ),
    [run],
  );

  const createBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) {
      return false;
    }
    const created = await run(
      () => setCreatingBranch(true),
      () => setCreatingBranch(false),
      `Could not create ${name}.`,
      async (client, cwd) => {
        await client.gitCreateBranch(cwd, name);
        return `Switched to the new branch ${name}.`;
      },
    );
    if (created) {
      setNewBranchName('');
    }
    return created;
  }, [newBranchName, run]);

  const origin = initOrigin.trim();
  const initOriginError = origin ? httpsRemoteError(origin) : null;
  const initializeRepository = useCallback(async () => {
    if (initOriginError) {
      return false;
    }
    const initialized = await run(
      () => setInitializing(true),
      () => setInitializing(false),
      'Could not initialize Git.',
      async (client, cwd) => {
        await client.gitInit(cwd, origin || null);
        return origin ? 'Initialized Git with origin.' : 'Initialized Git.';
      },
    );
    if (initialized) {
      setInitOrigin('');
    }
    return initialized;
  }, [initOriginError, origin, run]);

  return {
    features,
    notice,
    setNotice,
    syncing,
    discardingPath,
    discardingAll,
    initializing,
    creatingBranch,
    newBranchName,
    setNewBranchName,
    initOrigin,
    setInitOrigin,
    initOriginError,
    fetch,
    pull,
    discardFile,
    discardAll,
    createBranch,
    initializeRepository,
  };
}
