import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';

import type {
  GitBranchesResponse,
  GitDiffResponse,
  GitHistoryResponse,
  GitStatusResponse,
} from '@bridge/types/types';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { LocalAction, LocalCard, LocalField, LocalPage, LocalText, useLocalOperation } from './ui';
import { GitTransferProgress } from './GitTransferProgress';

interface GitSnapshot {
  status: GitStatusResponse;
  diff: GitDiffResponse;
  history: GitHistoryResponse;
  branches: GitBranchesResponse;
}

export function LocalGitScreen() {
  const runtime = useOnDeviceRuntime();
  const { workspaceId } = useLocalSearchParams<{ workspaceId?: string }>();
  const id = workspaceId ?? runtime.preferences().workspaceId;
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
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
  const action = (label: string, run: (workspace: string) => Promise<unknown>) => {
    if (!id) {
      return;
    }
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
      busy={operation.busy || (!snapshot && !loadError && Boolean(id))}
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
      {snapshot ? (
        <>
          <LocalText title>
            {snapshot.status.branch} · {gitStatusLabel(snapshot.status)}
          </LocalText>
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
            {snapshot.status.files.map((file) => (
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
            {snapshot.status.truncated ? (
              <LocalText>
                File list truncated; {snapshot.status.omittedFiles} omitted. Stage-all includes all
                eligible changes.
              </LocalText>
            ) : null}
          </LocalCard>
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
              disabled={busy || !message.trim()}
              onPress={() =>
                action('Committing changes', async (workspace) => {
                  const author = runtime.preferences().author;
                  if (!author) {
                    throw new Error(
                      'Set your author name and email in GitHub and author settings first.',
                    );
                  }
                  await runtime.native.commitWorkspaceGit(
                    workspace,
                    message,
                    author.name,
                    author.email,
                  );
                  setMessage('');
                })
              }
            />
            <LocalAction
              title="Push current branch"
              disabled={busy}
              onPress={() =>
                action('Pushing current branch', (workspace) => runtime.pushWorkspace(workspace))
              }
            />
          </LocalCard>
          <LocalCard>
            <LocalText title>Branches</LocalText>
            {snapshot.branches.branches.map((branch) => (
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
          <LocalCard>
            <LocalText title>Recent commits</LocalText>
            {snapshot.history.commits.map((commit) => (
              <LocalText key={commit.hash}>
                {commit.shortHash} {commit.subject} · {commit.authorName}
              </LocalText>
            ))}
          </LocalCard>
        </>
      ) : null}
    </LocalPage>
  );
}

function gitStatusLabel(status: GitStatusResponse): string {
  return status.clean ? 'Working tree clean' : `${status.totalFiles} changed files`;
}

async function readGit(
  native: ReturnType<typeof useOnDeviceRuntime>['native'],
  id: string,
): Promise<GitSnapshot> {
  const [status, diff, history, branches] = await Promise.all([
    native.getWorkspaceGitStatus(id),
    native.getWorkspaceGitDiff(id, null),
    native.getWorkspaceGitHistory(id),
    native.getWorkspaceGitBranches(id),
  ]);
  return { status, diff, history, branches };
}
