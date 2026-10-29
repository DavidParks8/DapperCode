import type { OnDeviceNativeServices } from './services.types';

export function getOnDeviceNativeServices(): OnDeviceNativeServices {
  throw new Error('On-device agent services require a native iOS build.');
}
