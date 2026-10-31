import { Platform } from 'react-native';

import { getOnDeviceNativeServices } from '../../features/on-device/native/services';

/**
 * Whether this build can run the local agent: iOS with the on-device native module at the expected
 * ABI. Android, web, and outdated native builds never resolve to the local profile.
 */
export function detectLocalProfileSupport(platform: string = Platform.OS): boolean {
  if (platform !== 'ios') {
    return false;
  }
  try {
    getOnDeviceNativeServices();
    return true;
  } catch {
    return false;
  }
}
