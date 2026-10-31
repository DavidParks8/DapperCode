import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';

export interface FakeSetupRuntimeState {
  modelId: string | null;
  workspaceId: string | null;
  workspaces: readonly { id: string; name: string }[];
  downloadPhase: string;
}

/** The slice of the on-device runtime that setup progress reads, with a change trigger. */
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
    preferences: () => ({ modelId: state.modelId, workspaceId: state.workspaceId }),
    workspaces: () => state.workspaces,
    downloads: {
      snapshot: () => ({ phase: state.downloadPhase, bytesWritten: 0 }),
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
