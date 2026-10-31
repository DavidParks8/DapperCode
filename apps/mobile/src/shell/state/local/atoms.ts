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
