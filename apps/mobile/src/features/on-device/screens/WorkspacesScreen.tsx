import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { LocalAction, LocalCard, LocalField, LocalPage, LocalText, useLocalOperation } from './ui';
import { GitTransferProgress } from './GitTransferProgress';

export function LocalWorkspacesScreen() {
  const runtime = useOnDeviceRuntime();
  const router = useRouter();
  const operation = useLocalOperation();
  const [name, setName] = useState('');
  const [remote, setRemote] = useState('');
  return (
    <LocalPage title="Local workspaces" busy={operation.busy} error={operation.error}>
      <LocalText>
        Only app-private workspaces are accessible to tools. Clones require HTTPS and network
        access. Files and local commits remain usable offline.
      </LocalText>
      <GitTransferProgress watch={operation.busy} />
      <LocalCard>
        <LocalText title>Clone a repository</LocalText>
        <LocalField label="Workspace name" value={name} onChangeText={setName} maxLength={100} />
        <LocalField
          label="HTTPS repository URL"
          value={remote}
          onChangeText={setRemote}
          placeholder="https://github.com/owner/repository.git"
          keyboardType="url"
        />
        <LocalText>
          {runtime.preferences().account
            ? `Signed in as ${runtime.preferences().account?.login ?? ''}`
            : 'Public clones work without sign-in. Sign in to GitHub for private repositories and push.'}
        </LocalText>
        <LocalAction
          title="Clone to this iPhone"
          disabled={operation.busy || !name.trim() || !remote.trim()}
          onPress={() =>
            operation.run(async () => {
              await runtime.cloneWorkspace(name.trim(), remote.trim());
              setName('');
              setRemote('');
            })
          }
        />
        <LocalAction
          title="Create empty file workspace"
          disabled={operation.busy || !name.trim()}
          onPress={() =>
            operation.run(async () => {
              await runtime.createWorkspace(name.trim());
              setName('');
            })
          }
        />
        <LocalText>
          Empty workspaces support file tools. Git operations require a cloned repository.
        </LocalText>
      </LocalCard>
      {runtime.workspaces().map((workspace) => (
        <LocalCard key={workspace.id}>
          <LocalText title>
            {workspace.name}
            {workspace.id === runtime.preferences().workspaceId ? ' · Selected' : ''}
          </LocalText>
          <LocalAction
            title={`Use ${workspace.name}`}
            disabled={operation.busy}
            onPress={() => operation.run(() => runtime.selectWorkspace(workspace.id))}
          />
          <LocalAction
            title={`Browse ${workspace.name}`}
            onPress={() =>
              router.push({ pathname: '/on-device/files', params: { workspaceId: workspace.id } })
            }
          />
        </LocalCard>
      ))}
      <LocalAction
        title="Refresh workspaces"
        disabled={operation.busy}
        onPress={() => operation.run(() => runtime.refreshWorkspaces())}
      />
    </LocalPage>
  );
}
