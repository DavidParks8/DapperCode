import { requireOptionalNativeModule } from 'expo';
import type * as ExpoNetwork from 'expo-network';
import { reachability, unknownNetwork, type OnDeviceNetworkPort } from './network';

/**
 * Observes reachability with expo-network. Binaries built before the native module was added
 * report `unknown`, which never blocks network actions.
 */
export function createExpoNetwork(): OnDeviceNetworkPort {
  if (!requireOptionalNativeModule('ExpoNetwork')) {
    return unknownNetwork;
  }
  // Loaded lazily: importing expo-network eagerly throws when its native module is missing.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const network = require('expo-network') as typeof ExpoNetwork;
  return {
    current: async () => reachability(await network.getNetworkStateAsync()),
    subscribe: (listener) => {
      const subscription = network.addNetworkStateListener((state) =>
        listener(reachability(state)),
      );
      return () => subscription.remove();
    },
  };
}
