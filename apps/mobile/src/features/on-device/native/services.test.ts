import { getOnDeviceNativeServices } from './services.ios';
import { ON_DEVICE_NATIVE_API_VERSION } from './services.types';

const mockNativeLookup = jest.fn();
jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => mockNativeLookup(name),
}));

test('old native builds are rejected before exposing models requiring the updated engine', () => {
  mockNativeLookup.mockReturnValue({ getAPIVersion: () => ON_DEVICE_NATIVE_API_VERSION - 1 });
  expect(() => getOnDeviceNativeServices()).toThrow('Rebuild the native iOS app');
});

test('the current native build passes the version boundary unchanged', () => {
  const native = { getAPIVersion: () => ON_DEVICE_NATIVE_API_VERSION };
  mockNativeLookup.mockReturnValue(native);
  expect(getOnDeviceNativeServices()).toBe(native);
});
