import { atom } from 'jotai';

import type { HostBridgeWsClient } from '@bridge/ws/ws';
import type { OnDeviceRuntime } from '../../../features/on-device/runtime/runtime';

/**
 * The on-device runtime while the shell's local runtime host owns one. `null` while the local
 * profile is closed or the runtime is still starting. Legacy `/on-device/*` screens and Settings
 * entry points read it; chat surfaces never do — they use the transport below.
 */
export const localRuntimeAtom = atom<OnDeviceRuntime | null>(null);

/** The in-process bridge transport for the local profile, published with the runtime. */
export const localTransportAtom = atom<HostBridgeWsClient | null>(null);

export interface LocalAgentPresence {
  /** One-line agent status, such as "Qwen3 1.7B Q4_K_M · ready on this iPhone". */
  status: { label: string; kind: 'busy' | 'ready' | 'attention' | 'error' };
  /** Why a new chat cannot start yet, with the next step; null when it can. */
  readiness: {
    reason: string;
    action: 'choose-model' | 'download-model' | 'wait-for-download' | 'choose-workspace' | null;
  } | null;
  /** The workspace a new chat would use when none is chosen, as a presented path. */
  defaultWorkspacePath: string | null;
}

/**
 * Status and new-chat readiness of the local agent, published by the runtime host while the local
 * profile is open. Null for desktop profiles, so shared surfaces render it without branching.
 */
export const localAgentPresenceAtom = atom<LocalAgentPresence | null>(null);
