import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import {
  ON_DEVICE_RUNTIME_SLICES,
  type OnDeviceRuntimeSlice,
} from '../../features/on-device/runtime/types';

export interface FakeSetupRuntimeState {
  modelId: string | null;
  workspaceId: string | null;
  workspaces: readonly { id: string; name: string }[];
  /** Phase of the selected model, and of any model without an entry in `downloadPhases`. */
  downloadPhase: string;
  /** Per-model phases, for models other than the selected one. */
  downloadPhases?: Record<string, string>;
  author?: { name: string; email: string } | null;
  /** Message counts of the local conversations. */
  threadMessages?: readonly number[];
}

/** The slice of the on-device runtime that setup progress reads, with a change trigger. */
const EMPTY_MODEL_SESSION = {
  phase: 'empty',
  modelId: null,
  progress: 0,
  error: null,
  contextTokens: null,
} as const;

const NO_ISSUES: readonly never[] = [];

export function createFakeSetupRuntime(initial: FakeSetupRuntimeState) {
  let state = initial;
  const versions = new Map<OnDeviceRuntimeSlice, number>();
  const listeners = new Set<{ listener: () => void; slices: readonly OnDeviceRuntimeSlice[] }>();
  const notify = (changed: readonly OnDeviceRuntimeSlice[]) => {
    for (const slice of changed) {
      versions.set(slice, (versions.get(slice) ?? 0) + 1);
    }
    [...listeners].forEach(({ listener, slices }) => {
      if (changed.some((slice) => slices.includes(slice))) {
        listener();
      }
    });
  };
  const runtime = {
    subscribe: (
      listener: () => void,
      slices: readonly OnDeviceRuntimeSlice[] = ON_DEVICE_RUNTIME_SLICES,
    ) => {
      const entry = { listener, slices };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    version: (slices: readonly OnDeviceRuntimeSlice[] = ON_DEVICE_RUNTIME_SLICES) =>
      slices.reduce((total, slice) => total + (versions.get(slice) ?? 0), 0),
    preferences: () => ({
      modelId: state.modelId,
      workspaceId: state.workspaceId,
      author: state.author ?? null,
    }),
    threads: {
      list: () =>
        (state.threadMessages ?? []).map((count) => ({ messages: new Array<unknown>(count) })),
    },
    workspaces: () => state.workspaces,
    issues: () => NO_ISSUES,
    models: {
      snapshot: () => EMPTY_MODEL_SESSION,
      resident: () => null,
    },
    downloads: {
      snapshot: (id: string) => ({
        phase:
          state.downloadPhases?.[id] ??
          (state.downloadPhases && id !== state.modelId ? 'not_downloaded' : state.downloadPhase),
        bytesWritten: 0,
      }),
    },
  };
  return {
    runtime: runtime as unknown as OnDeviceRuntime,
    /** Changes state and notifies every slice. */
    update(next: Partial<FakeSetupRuntimeState>) {
      state = { ...state, ...next };
      notify(ON_DEVICE_RUNTIME_SLICES);
    },
    /** Notifies only `slices` without changing what setup reads, like a progress tick. */
    emit(...slices: OnDeviceRuntimeSlice[]) {
      notify(slices);
    },
  };
}
