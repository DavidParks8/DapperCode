import { LOCAL_MODEL_CATALOG } from '../../features/on-device/models/catalog';
import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import {
  localAgentStatus,
  localConversationReadiness,
} from '../../features/on-device/runtime/status';
import type { OnDeviceRuntimeSlice } from '../../features/on-device/runtime/types';
import {
  localWorkspaceIdForPath,
  localWorkspacePaths,
} from '../../features/on-device/transport/wire';
import type { LocalAgentPresence } from '@shell/state/local/atoms';

/** Runtime slices the presence depends on; download ticks are included for "Downloading · N%". */
export const LOCAL_PRESENCE_SLICES: readonly OnDeviceRuntimeSlice[] = [
  'loop',
  'models',
  'downloads',
  'preferences',
  'workspaces',
  'threads',
];

/**
 * The model and workspace a new local chat would use, mirroring `LocalBridgeServer`'s fallbacks
 * (requested path, remembered choice, most recent chat, the only workspace).
 */
function newChatDefaults(runtime: OnDeviceRuntime, cwd: string | null) {
  const preferences = runtime.preferences();
  const recent = runtime.threads.list()[0] ?? null;
  const available = LOCAL_MODEL_CATALOG.filter(
    (model) => !model.runtimeIssue && runtime.downloads.snapshot(model.id).phase === 'ready',
  );
  const runnable = (id: string | null | undefined) =>
    id && available.some((model) => model.id === id) ? id : null;
  const modelId =
    runnable(preferences.modelId) ??
    runnable(recent?.modelId) ??
    available[0]?.id ??
    preferences.modelId ??
    null;
  const workspaces = runtime.workspaces();
  const exists = (id: string | null | undefined) =>
    id && workspaces.some((workspace) => workspace.id === id) ? id : null;
  const workspaceId =
    localWorkspaceIdForPath(workspaces, cwd) ??
    exists(preferences.workspaceId) ??
    exists(recent?.workspaceId) ??
    (workspaces.length === 1 ? (workspaces[0]?.id ?? null) : null);
  return { modelId, workspaceId, workspaces };
}

/**
 * What the shell shows about the local agent outside a conversation: the drawer status line and
 * whether (and why not) a new chat can start, with the next step.
 */
export function describeLocalAgentPresence(
  runtime: OnDeviceRuntime,
  cwd: string | null,
): LocalAgentPresence {
  const { modelId, workspaceId, workspaces } = newChatDefaults(runtime, cwd);
  const download = modelId ? runtime.downloads.snapshot(modelId) : null;
  const status = localAgentStatus({
    run: runtime.loop.snapshot(),
    model: runtime.models.snapshot(),
    thread: null,
    modelId,
    download,
    workspaceActivity: runtime.workspaceActivity(),
  });
  const readiness = localConversationReadiness({ modelId, download, workspaceId, workspaces });
  return {
    status: { label: status.label, kind: status.kind },
    readiness:
      readiness.canStart || !readiness.reason
        ? null
        : { reason: readiness.reason, action: readiness.action },
    defaultWorkspacePath: workspaceId
      ? (localWorkspacePaths(workspaces).get(workspaceId) ?? null)
      : null,
  };
}

export function sameLocalAgentPresence(a: LocalAgentPresence | null, b: LocalAgentPresence) {
  return (
    a !== null &&
    a.status.label === b.status.label &&
    a.status.kind === b.status.kind &&
    a.readiness?.reason === b.readiness?.reason &&
    a.readiness?.action === b.readiness?.action &&
    a.defaultWorkspacePath === b.defaultWorkspacePath
  );
}
