import { requireOptionalNativeModule } from 'expo';
import { withNativeErrorMapping } from './services.errors';
import { ON_DEVICE_NATIVE_API_VERSION } from './services.types';
import type { OnDeviceNativeServices } from './services.types';

export function getOnDeviceNativeServices(): OnDeviceNativeServices {
  const services = requireOptionalNativeModule<OnDeviceNativeServices>('OnDeviceAgent');
  if (
    !services ||
    typeof services.getAPIVersion !== 'function' ||
    services.getAPIVersion() !== ON_DEVICE_NATIVE_API_VERSION
  ) {
    throw new Error('On-device services are unavailable or outdated. Rebuild the native iOS app.');
  }
  return withNativeErrorMapping(services);
}
