import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';

import { findLocalModelDefinition } from '../models/catalog';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { localAgentStatus, localConversationReadiness } from '../runtime/status';
import { LocalAction, LocalCard, LocalPage, LocalText, useLocalOperation } from './ui';

export function OnDeviceHomeScreen({ executionTargets }: { executionTargets: ReactNode }) {
  const runtime = useOnDeviceRuntime();
  const router = useRouter();
  const operation = useLocalOperation();
  const preferences = runtime.preferences();
  const workspace = runtime.workspaces().find((entry) => entry.id === preferences.workspaceId);
  const download =
    preferences.modelId && findLocalModelDefinition(preferences.modelId)
      ? runtime.downloads.snapshot(preferences.modelId)
      : null;
  const status = localAgentStatus({
    run: runtime.loop.snapshot(),
    model: runtime.models.snapshot(),
    thread: null,
    modelId: preferences.modelId,
    download,
    workspaceActivity: runtime.workspaceActivity(),
  });
  const readiness = localConversationReadiness({
    modelId: preferences.modelId,
    download,
    workspaceId: preferences.workspaceId,
    workspaces: runtime.workspaces(),
  });
  const failure = runtime.error();
  return (
    <LocalPage
      title="On this iPhone"
      busy={operation.busy}
      error={operation.error ?? failure?.message}
      navigation={<LocalText>Offline</LocalText>}
    >
      <LocalText>
        Private coding with native file and Git tools. Download a model and clone a workspace while
        online; then chat, edit, and commit offline. No desktop or cloud fallback.
      </LocalText>
      {failure ? (
        <LocalAction
          title="Retry saving local state"
          onPress={() =>
            operation.run(async () => {
              await runtime.threads.retryPersistence();
              await runtime.flush();
              runtime.dismissError();
            })
          }
        />
      ) : null}
      <LocalCard>
        <LocalText title>{workspace?.name ?? 'Choose a workspace'}</LocalText>
        <LocalText>{status.label}</LocalText>
        {status.detail ? <LocalText>{status.detail}</LocalText> : null}
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
          disabled={operation.busy || !readiness.canStart}
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
        {readiness.reason ? <LocalText>{readiness.reason}</LocalText> : null}
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
            onPress={() => operation.run(() => runtime.threads.remove(thread.id))}
          />
        </LocalCard>
      ))}
      {executionTargets}
    </LocalPage>
  );
}
