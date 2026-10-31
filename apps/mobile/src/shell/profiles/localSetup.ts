import type { Href } from 'expo-router';
import { useAtomValue } from 'jotai';
import { useCallback, useSyncExternalStore } from 'react';

import { findLocalModelDefinition } from '../../features/on-device/models/catalog';
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

export function localSetupState(runtime: LocalSetupRuntime): LocalSetupState {
  const { modelId, workspaceId } = runtime.preferences();
  const workspaces = runtime.workspaces();
  const download =
    modelId && findLocalModelDefinition(modelId) ? runtime.downloads.snapshot(modelId) : null;
  const readiness = localConversationReadiness({ modelId, download, workspaceId, workspaces });
  const model: LocalSetupStepStatus =
    readiness.canStart || readiness.action === 'choose-workspace'
      ? 'done'
      : readiness.action === 'wait-for-download'
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
