import type { Href } from 'expo-router';
import { useAtomValue } from 'jotai';
import { useCallback, useSyncExternalStore } from 'react';

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
import { localRuntimeAtom } from '@shell/state/local/atoms';

/**
 * Where first-run setup sends the user. These are the legacy model library and workspace screens
 * until the Settings model screens and the local workspace picker replace them; update only this
 * constant when they do (see docs/on-device.md, "Discovery and onboarding").
 */
export const LOCAL_SETUP_DESTINATIONS = {
  models: '/on-device/models',
  workspaces: '/on-device/workspaces',
} as const satisfies Record<string, Href>;

export type LocalSetupStepStatus = 'done' | 'in-progress' | 'todo';

/** First-run progress for the built-in profile: a runnable model, then a workspace. */
export interface LocalSetupState {
  readiness: LocalConversationReadiness;
  model: LocalSetupStepStatus;
  workspace: LocalSetupStepStatus;
  /** A short status for profile lists, such as "Ready" or "Needs a model". */
  summary: string;
}

type LocalSetupRuntime = Pick<OnDeviceRuntime, 'preferences' | 'workspaces' | 'downloads'>;

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

export function localSetupState(runtime: LocalSetupRuntime): LocalSetupState {
  const { modelId: selected, workspaceId } = runtime.preferences();
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
  return { readiness, model, workspace, summary };
}

const SETUP_SLICES: readonly OnDeviceRuntimeSlice[] = ['preferences', 'downloads', 'workspaces'];
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
