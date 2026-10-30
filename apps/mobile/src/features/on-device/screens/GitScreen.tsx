import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';

import type { GitBranchesResponse, GitDiffResponse, GitHistoryResponse } from '@bridge/types/types';
import { isOnDeviceNativeError } from '../native/services.errors';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import type { LocalGitStatus } from '../workspaces/types';
import { LocalAction, LocalCard, LocalField, LocalPage, LocalText, useLocalOperation } from './ui';
import { GitTransferProgress } from './GitTransferProgress';

interface GitSnapshot {
  status: LocalGitStatus;
  diff: GitDiffResponse;
  history: GitHistoryResponse;
  branches: GitBranchesResponse;
}

type GitState = GitSnapshot | { notRepository: true };
type GitAction = (label: string, run: (workspace: string) => Promise<unknown>) => void;

export function LocalGitScreen() {
  const runtime = useOnDeviceRuntime();
  const { workspaceId } = useLocalSearchParams<{ workspaceId?: string }>();
  const id = workspaceId ?? runtime.preferences().workspaceId;
  const [state, setSnapshot] = useState<GitState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const operation = useLocalOperation();
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setLoadError(null);
    if (id) {
      void readGit(runtime.native, id)
        .then((value) => {
          if (active) {
            setSnapshot(value);
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setLoadError(
              error instanceof Error ? error.message : 'Could not read local Git state.',
            );
          }
        });
    }
    return () => {
      active = false;
    };
  }, [id, runtime]);
  const busy = operation.busy || runtime.workspaceBusy();
  const action: GitAction = (label, run) => {
    if (!id) {
      return;
    }
    setNotice(null);
    operation.run(() =>
      runtime.workspaceTask(label, async () => {
        await run(id);
        setSnapshot(await readGit(runtime.native, id));
        setLoadError(null);
      }),
    );
  };
  return (
    <LocalPage
      title="Local Git"
      busy={operation.busy || (!state && !loadError && Boolean(id))}
      error={operation.error ?? loadError}
    >
      <LocalText title>
        {runtime.workspaces().find((entry) => entry.id === id)?.name ??
          'Choose a cloned workspace first'}
      </LocalText>
      <LocalText>
        Stage, review, and commit offline. Push requires network and permission to the origin.
        Running tools must settle before manual mutations.
      </LocalText>
      <GitTransferProgress watch={operation.busy} />
      <LocalAction
        title="Refresh Git"
        disabled={busy || !id}
        onPress={() => action('Reading Git state', () => Promise.resolve())}
      />
      {notice ? <LocalText>{notice}</LocalText> : null}
      {state ? (
        <GitStateView state={state} busy={busy} action={action} onNotice={setNotice} />
      ) : null}
    </LocalPage>
  );
}

function GitStateView({
  state,
  busy,
  action,
  onNotice,
}: {
  state: GitState;
  busy: boolean;
  action: GitAction;
  onNotice: (notice: string) => void;
}) {
  return 'notRepository' in state ? (
    <GitInitCard busy={busy} action={action} />
  ) : (
    <GitSnapshotView snapshot={state} busy={busy} action={action} onNotice={onNotice} />
  );
}

function GitSnapshotView({
  snapshot,
  busy,
  action,
  onNotice,
}: {
  snapshot: GitSnapshot;
  busy: boolean;
  action: GitAction;
  onNotice: (notice: string) => void;
}) {
  return (
    <>
      <LocalText title>
        {snapshot.status.branch} · {gitStatusLabel(snapshot.status)}
      </LocalText>
      <LocalText>{gitRemoteLabel(snapshot.status)}</LocalText>
      <GitChangesCard status={snapshot.status} busy={busy} action={action} />
      <LocalCard>
        <LocalText title>Diff</LocalText>
        <LocalText mono>
          {snapshot.diff.diff || 'No tracked diff. New untracked files appear after staging.'}
        </LocalText>
        {snapshot.diff.truncated ? (
          <LocalText>
            Diff truncated at {snapshot.diff.returnedBytes} bytes. Review omitted changes before
            committing.
          </LocalText>
        ) : null}
      </LocalCard>
      <GitCommitCard status={snapshot.status} busy={busy} action={action} onNotice={onNotice} />
      <GitBranchesCard branches={snapshot.branches} busy={busy} action={action} />
      <LocalCard>
        <LocalText title>Recent commits</LocalText>
        {snapshot.history.commits.map((commit) => (
          <LocalText key={commit.hash}>
            {commit.shortHash} {commit.subject} · {commit.authorName}
          </LocalText>
        ))}
      </LocalCard>
    </>
  );
}

function GitChangesCard({
  status,
  busy,
  action,
}: {
  status: LocalGitStatus;
  busy: boolean;
  action: GitAction;
}) {
  const runtime = useOnDeviceRuntime();
  return (
    <LocalCard>
      <LocalAction
        title="Stage all changes"
        disabled={busy}
        onPress={() =>
          action('Staging changes', (workspace) =>
            runtime.native.stageWorkspaceGit(workspace, null),
          )
        }
      />
      <LocalAction
        title="Unstage all changes"
        disabled={busy}
        onPress={() =>
          action('Unstaging changes', (workspace) =>
            runtime.native.unstageWorkspaceGit(workspace, null),
          )
        }
      />
      {status.files.map((file) => (
        <LocalCard key={file.path}>
          <LocalText mono>
            {file.indexStatus}
            {file.worktreeStatus} {file.path}
          </LocalText>
          {file.unstaged || file.untracked ? (
            <LocalAction
              title={`Stage ${file.path}`}
              disabled={busy}
              onPress={() =>
                action('Staging file', (workspace) =>
                  runtime.native.stageWorkspaceGit(workspace, file.path),
                )
              }
            />
          ) : null}
          {file.staged ? (
            <LocalAction
              title={`Unstage ${file.path}`}
              disabled={busy}
              onPress={() =>
                action('Unstaging file', (workspace) =>
                  runtime.native.unstageWorkspaceGit(workspace, file.path),
                )
              }
            />
          ) : null}
        </LocalCard>
      ))}
      {status.truncated ? (
        <LocalText>
          File list truncated; {status.omittedFiles} omitted. Stage-all includes all eligible
          changes.
        </LocalText>
      ) : null}
    </LocalCard>
  );
}

function GitCommitCard({
  status,
  busy,
  action,
  onNotice,
}: {
  status: LocalGitStatus;
  busy: boolean;
  action: GitAction;
  onNotice: (notice: string) => void;
}) {
  const runtime = useOnDeviceRuntime();
  const [message, setMessage] = useState('');
  return (
    <LocalCard>
      <LocalField
        label="Commit message"
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={10000}
      />
      <LocalAction
        title="Commit staged changes"
        disabled={busy || !message.trim() || status.stagedFiles === 0}
        onPress={() =>
          action('Committing changes', async (workspace) => {
            const author = runtime.preferences().author;
            if (!author) {
              throw new Error(
                'Set your author name and email in GitHub and author settings first.',
              );
            }
            await runtime.native.commitWorkspaceGit(workspace, message, author.name, author.email);
            setMessage('');
          })
        }
      />
      <GitSyncActions status={status} busy={busy} action={action} onNotice={onNotice} />
    </LocalCard>
  );
}

function GitInitCard({ busy, action }: { busy: boolean; action: GitAction }) {
  const runtime = useOnDeviceRuntime();
  const [origin, setOrigin] = useState('');
  return (
    <LocalCard>
      <LocalText title>Not a Git repository</LocalText>
      <LocalText>Initialize Git to stage, commit, and push changes in this workspace.</LocalText>
      <LocalField
        label="Origin URL (optional)"
        value={origin}
        onChangeText={setOrigin}
        placeholder="https://github.com/owner/repository.git"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <LocalAction
        title="Initialize Git"
        disabled={busy}
        onPress={() =>
          action('Initializing Git', async (workspace) => {
            await runtime.native.initWorkspaceGit(workspace, 'main', origin.trim() || null);
            await runtime.refreshWorkspaces();
            setOrigin('');
          })
        }
      />
    </LocalCard>
  );
}

function GitSyncActions({
  status,
  busy,
  action,
  onNotice,
}: {
  status: LocalGitStatus;
  busy: boolean;
  action: GitAction;
  onNotice: (notice: string) => void;
}) {
  const runtime = useOnDeviceRuntime();
  const noRemote = busy || !status.hasOrigin;
  const noBranch = noRemote || status.detached;
  return (
    <>
      <LocalAction
        title="Push current branch"
        disabled={noBranch}
        onPress={() =>
          action('Pushing current branch', async (workspace) =>
            runtime.native.pushWorkspaceGit(workspace, await runtime.credential(workspace)),
          )
        }
      />
      <LocalAction
        title="Fetch from origin"
        disabled={noRemote}
        onPress={() =>
          action('Fetching from origin', async (workspace) =>
            runtime.native.fetchWorkspaceGit(workspace, await runtime.credential(workspace)),
          )
        }
      />
      <LocalAction
        title="Pull (fast-forward only)"
        disabled={noBranch}
        onPress={() =>
          action('Pulling from origin', async (workspace) => {
            const result = await runtime.native.pullWorkspaceGit(
              workspace,
              await runtime.credential(workspace),
            );
            onNotice(
              result.outcome === 'up-to-date'
                ? 'Already up to date.'
                : `Fast-forwarded to ${result.to.slice(0, 7)}.`,
            );
          })
        }
      />
    </>
  );
}

function GitBranchesCard({
  branches,
  busy,
  action,
}: {
  branches: GitBranchesResponse;
  busy: boolean;
  action: GitAction;
}) {
  const runtime = useOnDeviceRuntime();
  const [branchName, setBranchName] = useState('');
  return (
    <LocalCard>
      <LocalText title>Branches</LocalText>
      <LocalField
        label="New branch name"
        value={branchName}
        onChangeText={setBranchName}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <LocalAction
        title="Create and switch to branch"
        disabled={busy || !branchName.trim()}
        onPress={() =>
          action('Creating branch', async (workspace) => {
            await runtime.native.createWorkspaceGitBranch(workspace, branchName.trim(), true);
            setBranchName('');
          })
        }
      />
      {branches.branches.map((branch) => (
        <LocalAction
          key={branch.name}
          title={`${branch.name}${branch.current ? ' · Current' : ''}`}
          disabled={busy || branch.current}
          onPress={() =>
            action('Switching branch', (workspace) =>
              runtime.native.switchWorkspaceGitBranch(workspace, branch.name),
            )
          }
        />
      ))}
    </LocalCard>
  );
}

function gitStatusLabel(status: LocalGitStatus): string {
  return status.clean ? 'Working tree clean' : `${status.totalFiles} changed files`;
}

export function gitRemoteLabel(status: LocalGitStatus): string {
  if (!status.hasOrigin) {
    return 'No origin remote. Push, fetch, and pull need an origin.';
  }
  if (status.detached) {
    return 'Detached HEAD. Switch to a branch to push or pull.';
  }
  if (!status.upstream || status.ahead === null || status.behind === null) {
    return 'No upstream branch yet. Push to publish this branch.';
  }
  if (status.ahead === 0 && status.behind === 0) {
    return `Up to date with ${status.upstream}.`;
  }
  return `${status.ahead} ahead, ${status.behind} behind ${status.upstream}.`;
}

async function readGit(
  native: ReturnType<typeof useOnDeviceRuntime>['native'],
  id: string,
): Promise<GitState> {
  let status: LocalGitStatus;
  try {
    status = await native.getWorkspaceGitStatus(id);
  } catch (error) {
    if (isOnDeviceNativeError(error, 'GIT_NOT_REPOSITORY')) {
      return { notRepository: true };
    }
    throw error;
  }
  const [diff, history, branches] = await Promise.all([
    native.getWorkspaceGitDiff(id, null),
    native.getWorkspaceGitHistory(id),
    native.getWorkspaceGitBranches(id),
  ]);
  return { status, diff, history, branches };
}
