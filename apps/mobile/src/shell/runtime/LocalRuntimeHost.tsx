import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  OnDeviceProvider,
  useOnDeviceRuntime,
} from '../../features/on-device/runtime/OnDeviceProvider';
import { createRuntimeAgentPort } from '../../features/on-device/transport/runtimePort';
import { LocalBridgeServer } from '../../features/on-device/transport/server';
import { activeProfileIsLocalAtom, localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import {
  localAgentPresenceAtom,
  localRuntimeAtom,
  localTransportAtom,
} from '@shell/state/local/atoms';
import {
  describeLocalAgentPresence,
  LOCAL_PRESENCE_SLICES,
  sameLocalAgentPresence,
} from './localAgentPresence';
import { LocalBridgeWsClient } from './LocalBridgeWsClient';
import { LocalProfileExit } from './LocalProfileExit';

export function isLegacyOnDevicePath(pathname: string): boolean {
  return pathname === '/on-device' || pathname.startsWith('/on-device/');
}

/**
 * Owns the single on-device runtime for the whole app. It exists only while the local profile is
 * open (or a legacy `/on-device/*` screen is shown) and disposes the runtime — stopping runs,
 * unloading the model, pausing downloads, cancelling sign-in — as soon as neither is true.
 *
 * While the runtime starts or fails to start, the provider's own page covers the shell; once it is
 * ready the host renders nothing and only publishes the runtime and its transport.
 */
export function LocalRuntimeHost() {
  const available = useAtomValue(localProfileAvailableAtom);
  const localProfile = useAtomValue(activeProfileIsLocalAtom);
  const pathname = usePathname();
  // Onboarding never shows local runtime pages, even while a local selection is being closed.
  if (
    !available ||
    pathname === '/onboarding' ||
    !(localProfile || isLegacyOnDevicePath(pathname))
  ) {
    return null;
  }
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="local-runtime-host">
      <OnDeviceProvider recoveryAction={<LocalProfileExit />}>
        <LocalTransportBinder />
        <LocalPresencePublisher />
      </OnDeviceProvider>
    </View>
  );
}

function LocalTransportBinder() {
  const runtime = useOnDeviceRuntime();
  const setRuntime = useSetAtom(localRuntimeAtom);
  const setTransport = useSetAtom(localTransportAtom);
  useEffect(() => {
    const transport = new LocalBridgeWsClient(
      new LocalBridgeServer(createRuntimeAgentPort(runtime)),
    );
    transport.connect();
    setRuntime(runtime);
    setTransport(transport);
    return () => {
      setTransport(null);
      setRuntime(null);
      transport.dispose();
    };
  }, [runtime, setRuntime, setTransport]);
  return null;
}

/**
 * Publishes the local agent's status and new-chat readiness for the drawer and the empty chat, and
 * seeds the new-chat workspace with the one the agent would use so the picker shows it.
 */
function LocalPresencePublisher() {
  const runtime = useOnDeviceRuntime();
  const [startCwd, setStartCwd] = useAtom(defaultStartCwdAtom);
  const setPresence = useSetAtom(localAgentPresenceAtom);
  useEffect(() => {
    let current: ReturnType<typeof describeLocalAgentPresence> | null = null;
    const publish = () => {
      const next = describeLocalAgentPresence(runtime, startCwd);
      if (!sameLocalAgentPresence(current, next)) {
        current = next;
        setPresence(next);
      }
    };
    publish();
    const unsubscribe = runtime.subscribe(publish, LOCAL_PRESENCE_SLICES);
    return () => {
      unsubscribe();
    };
  }, [runtime, setPresence, startCwd]);
  useEffect(() => () => setPresence(null), [setPresence]);
  useEffect(() => {
    if (startCwd) {
      return;
    }
    const seed = () => {
      const path = describeLocalAgentPresence(runtime, null).defaultWorkspacePath;
      if (path) {
        setStartCwd(path);
      }
    };
    seed();
    return runtime.subscribe(seed, ['workspaces', 'preferences']);
  }, [runtime, setStartCwd, startCwd]);
  return null;
}
