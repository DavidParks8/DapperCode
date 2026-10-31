import type { Href } from 'expo-router';
import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  findLocalModelDefinition,
  LOCAL_MODEL_CATALOG,
} from '../../features/on-device/models/catalog';
import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import {
  localConversationReadiness,
  type LocalConversationReadiness,
} from '../../features/on-device/runtime/status';
import type { OnDeviceRuntimeSlice } from '../../features/on-device/runtime/types';
import { localSetupCompletedAtom } from '@shell/state/appState/settings';
import { localRuntimeAtom } from '@shell/state/local/atoms';

/**
 * Where first-run setup sends the user for a model and a Git author: the local profile's
 * Settings → Models and Settings → Git & GitHub pages (see docs/on-device.md, "Discovery and
 * onboarding"). The workspace step opens the chat's workspace picker (`openWorkspaceModalAtom`),
 * which manages local workspaces.
 */
export const LOCAL_SETUP_DESTINATIONS = {
  models: '/profiles/on-device/settings/models',
  author: '/profiles/on-device/settings/github',
} as const satisfies Record<string, Href>;

/** `recommended` marks an optional step that is not done; it never blocks a chat. */
export type LocalSetupStepStatus = 'done' | 'in-progress' | 'todo' | 'recommended';

/**
 * First-run progress for the built-in profile: a runnable model, a workspace, a Git author for
 * commits, and the first chat. Only the model and workspace gate `readiness`.
 */
export interface LocalSetupState {
  readiness: LocalConversationReadiness;
  model: LocalSetupStepStatus;
  workspace: LocalSetupStepStatus;
  author: 'done' | 'recommended';
  /** Whether any local conversation has a message, which completes first-run setup. */
  chatStarted: boolean;
  /** A short status for profile lists, such as "Ready" or "Needs a model". */
  summary: string;
}

type LocalSetupRuntime = Pick<
  OnDeviceRuntime,
  'preferences' | 'workspaces' | 'downloads' | 'threads'
>;

const IN_PROGRESS_PHASES = new Set(['queued', 'preparing', 'downloading', 'verifying', 'loading']);

/**
 * The model a new chat would run, resolved like the local server's `resolveModel`: the selected
 * model when it is usable, otherwise any downloaded runnable model. With none usable yet, a
 * download in progress (selected first) stands in so setup reports it instead of "Needs a model".
 */
function effectiveModelId(runtime: LocalSetupRuntime, selected: string | null): string | null {
  const phase = (id: string) => runtime.downloads.snapshot(id).phase;
  const usable = (id: string | null) => {
    const definition = id ? findLocalModelDefinition(id) : null;
    return Boolean(definition && !definition.runtimeIssue && phase(definition.id) === 'ready');
  };
  if (usable(selected)) {
    return selected;
  }
  const runnable = LOCAL_MODEL_CATALOG.filter((model) => !model.runtimeIssue);
  const available = runnable.find((model) => usable(model.id));
  if (available) {
    return available.id;
  }
  if (selected && findLocalModelDefinition(selected) && IN_PROGRESS_PHASES.has(phase(selected))) {
    return selected;
  }
  return runnable.find((model) => IN_PROGRESS_PHASES.has(phase(model.id)))?.id ?? selected;
}

/** Whether any local conversation has a message. */
export function localChatStarted(runtime: Pick<OnDeviceRuntime, 'threads'>): boolean {
  return runtime.threads.list().some((thread) => thread.messages.length > 0);
}

export function localSetupState(runtime: LocalSetupRuntime): LocalSetupState {
  const { modelId: selected, workspaceId, author } = runtime.preferences();
  const workspaces = runtime.workspaces();
  const modelId = effectiveModelId(runtime, selected);
  const download =
    modelId && findLocalModelDefinition(modelId) ? runtime.downloads.snapshot(modelId) : null;
  // A queued download is already on its way; readiness otherwise asks to start it.
  const readiness = localConversationReadiness({
    modelId,
    download: download?.phase === 'queued' ? { ...download, phase: 'downloading' } : download,
    workspaceId,
    workspaces,
  });
  const model: LocalSetupStepStatus =
    readiness.canStart || readiness.action === 'choose-workspace'
      ? 'done'
      : download && IN_PROGRESS_PHASES.has(download.phase)
        ? 'in-progress'
        : 'todo';
  const workspace: LocalSetupStepStatus = workspaces.some((entry) => entry.id === workspaceId)
    ? 'done'
    : 'todo';
  const summary = readiness.canStart
    ? 'Ready'
    : model === 'in-progress'
      ? 'Downloading model'
      : model === 'todo'
        ? 'Needs a model'
        : 'Needs a workspace';
  return {
    readiness,
    model,
    workspace,
    author: author ? 'done' : 'recommended',
    chatStarted: localChatStarted(runtime),
    summary,
  };
}

const SETUP_SLICES: readonly OnDeviceRuntimeSlice[] = [
  'preferences',
  'downloads',
  'workspaces',
  'threads',
];
const noop = () => undefined;

/** Setup progress of the open local runtime; `null` while the local profile is closed. */
export function useLocalSetup(): LocalSetupState | null {
  const runtime = useAtomValue(localRuntimeAtom);
  const subscribe = useCallback(
    (listener: () => void) => (runtime ? runtime.subscribe(listener, SETUP_SLICES) : noop),
    [runtime],
  );
  const version = useCallback(() => (runtime ? runtime.version(SETUP_SLICES) : -1), [runtime]);
  useSyncExternalStore(subscribe, version, version);
  return runtime ? localSetupState(runtime) : null;
}

/**
 * Records once, in device-wide app settings, that a local chat has started. Deleted and
 * unrestorable chats leave the thread list, so first-run setup must not be derived from it alone.
 */
export function useRecordLocalSetupCompletion(
  runtime: Pick<OnDeviceRuntime, 'threads' | 'subscribe'>,
): void {
  const [completed, setCompleted] = useAtom(localSetupCompletedAtom);
  useEffect(() => {
    if (completed) {
      return;
    }
    const record = () => {
      if (localChatStarted(runtime)) {
        setCompleted(true);
      }
    };
    record();
    return runtime.subscribe(record, ['threads']);
  }, [completed, runtime, setCompleted]);
}
