import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';

import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import type { OnDeviceRuntimeSlice } from '../runtime/types';
import { LocalAction, LocalCard, LocalError, LocalPage, LocalText, useLocalOperation } from './ui';

const HOME_SLICES: readonly OnDeviceRuntimeSlice[] = [
  'threads',
  'models',
  'preferences',
  'workspaces',
  'issues',
  'network',
];

export function OnDeviceHomeScreen({ executionTargets }: { executionTargets: ReactNode }) {
  const runtime = useOnDeviceRuntime(HOME_SLICES);
  const router = useRouter();
  const operation = useLocalOperation();
  const preferences = runtime.preferences();
  const workspace = runtime.workspaces().find((entry) => entry.id === preferences.workspaceId);
  const model = runtime.models.snapshot();
  return (
    <LocalPage
      title="On this iPhone"
      busy={operation.busy}
      error={operation.error}
      navigation={<LocalText>{runtime.network() === 'offline' ? 'Offline' : ''}</LocalText>}
    >
      <LocalText>
        Private coding with native file and Git tools. Download a model and clone a workspace while
        online; then chat, edit, and commit offline. No desktop or cloud fallback.
      </LocalText>
      {runtime.issues().map((issue) => (
        <LocalCard key={issue.id}>
          <LocalError message={issue.message} />
          {issue.retryable ? (
            <LocalAction
              title="Retry saving"
              onPress={() => operation.run(() => runtime.retryPersistence())}
            />
          ) : null}
          <LocalAction title="Dismiss" onPress={() => runtime.dismissIssue(issue.id)} />
        </LocalCard>
      ))}
      <LocalCard>
        <LocalText title>{workspace?.name ?? 'Choose a workspace'}</LocalText>
        <LocalText>
          {model.phase === 'ready' ? 'Model loaded' : 'Model not loaded'} ·{' '}
          {preferences.modelId ?? 'No model selected'}
        </LocalText>
        <LocalAction
          title="Model library"
          testID="on-device-model-library"
          onPress={() => router.push('/on-device/models')}
        />
        <LocalAction title="Workspaces" onPress={() => router.push('/on-device/workspaces')} />
        <LocalAction title="Git changes" onPress={() => router.push('/on-device/git')} />
        <LocalAction title="GitHub and author" onPress={() => router.push('/on-device/account')} />
        <LocalAction
          title="New local conversation"
          testID="on-device-new-chat"
          disabled={operation.busy || !workspace || !preferences.modelId}
          onPress={() =>
            operation.run(async () => {
              const thread = await runtime.createThread();
              router.push({
                pathname: '/on-device/chat/[threadId]',
                params: { threadId: thread.id },
              });
            })
          }
        />
      </LocalCard>
      <LocalText title>Local conversations</LocalText>
      {runtime.threads.list().map((thread) => (
        <LocalCard key={thread.id}>
          <LocalAction
            title={thread.title}
            onPress={() =>
              router.push({
                pathname: '/on-device/chat/[threadId]',
                params: { threadId: thread.id },
              })
            }
          />
          <LocalText>
            {thread.status} ·{' '}
            {runtime.workspaces().find((entry) => entry.id === thread.workspaceId)?.name ??
              'Workspace unavailable'}
          </LocalText>
          <LocalAction
            title="Delete conversation"
            destructive
            disabled={operation.busy || thread.status === 'running'}
            onPress={() => operation.run(() => runtime.deleteThread(thread.id))}
          />
        </LocalCard>
      ))}
      {executionTargets}
    </LocalPage>
  );
}
