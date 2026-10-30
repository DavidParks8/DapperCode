import { useAtomValue, useSetAtom } from 'jotai';
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
import { localRuntimeAtom, localTransportAtom } from '@shell/state/local/atoms';
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
  if (!available || !(localProfile || isLegacyOnDevicePath(pathname))) {
    return null;
  }
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="local-runtime-host">
      <OnDeviceProvider recoveryAction={<LocalProfileExit />}>
        <LocalTransportBinder />
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
