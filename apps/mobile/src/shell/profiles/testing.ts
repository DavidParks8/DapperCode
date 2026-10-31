import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';

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
  let version = 0;
  const listeners = new Set<() => void>();
  const runtime = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
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
    update(next: Partial<FakeSetupRuntimeState>) {
      state = { ...state, ...next };
      version += 1;
      listeners.forEach((listener) => listener());
    },
  };
}
