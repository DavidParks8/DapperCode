import { LOCAL_MODEL_CATALOG } from '../../features/on-device/models/catalog';
import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import {
  localAgentStatus,
  localConversationReadiness,
} from '../../features/on-device/runtime/status';
import type { OnDeviceRuntimeSlice } from '../../features/on-device/runtime/types';
import {
  LOCAL_WORKSPACE_ROOT,
  localFallbackWorkspaceId,
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
  'issues',
];

/** Whether a path is one of this iPhone's presented workspace paths (or a stale one). */
function isLocalWorkspacePath(cwd: string | null): cwd is string {
  return cwd?.trim().startsWith(LOCAL_WORKSPACE_ROOT) === true;
}

/**
 * The model and workspace a new local chat would use, mirroring `LocalBridgeServer`'s fallbacks
 * (requested path, remembered choice, most recent chat, the only workspace). Like the server, a
 * local path that no longer resolves has no workspace rather than falling back to another one.
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
  const workspaceId = isLocalWorkspacePath(cwd)
    ? localWorkspaceIdForPath(workspaces, cwd)
    : localFallbackWorkspaceId(workspaces, preferences.workspaceId, recent?.workspaceId);
  return { modelId, workspaceId, workspaces };
}

/**
 * The new-chat workspace to remember instead of `cwd`, or `undefined` to keep it. A remembered
 * path that no longer names a workspace (it was deleted, or became ambiguous) is replaced with the
 * workspace a new chat would fall back to, or cleared, so the drawer's readiness and `thread/start`
 * always agree.
 */
export function repairedLocalStartCwd(
  runtime: OnDeviceRuntime,
  cwd: string | null,
): string | null | undefined {
  if (cwd && localWorkspaceIdForPath(runtime.workspaces(), cwd)) {
    return undefined;
  }
  const next = describeLocalAgentPresence(runtime, null).defaultWorkspacePath;
  return next === cwd ? undefined : next;
}

/**
 * What the shell shows about the local agent outside a conversation: the drawer status line and
 * whether (and why not) a new chat can start, with the next step.
 */
/**
 * Failed writes and startup or background problems are listed in Settings; while the agent is not
 * busy, the status points there instead of hiding them.
 */
function issueStatus(
  runtime: OnDeviceRuntime,
  kind: LocalAgentPresence['status']['kind'],
): LocalAgentPresence['status'] | null {
  const issues = runtime.issues();
  if (issues.length === 0 || kind === 'busy') {
    return null;
  }
  return {
    label:
      issues.length === 1
        ? '1 issue needs attention'
        : `${String(issues.length)} issues need attention`,
    kind: issues.some((issue) => issue.kind === 'persistence') ? 'error' : 'attention',
  };
}

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
    status: issueStatus(runtime, status.kind) ?? { label: status.label, kind: status.kind },
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
