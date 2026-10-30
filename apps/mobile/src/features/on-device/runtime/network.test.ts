import { requireOptionalNativeModule } from 'expo';
import { createExpoNetwork } from './expoNetwork';
import { reachability, unknownNetwork } from './network';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn(() => null) }));

test.each([
  [{ isConnected: false, isInternetReachable: null }, 'offline'],
  [{ isConnected: true, isInternetReachable: false }, 'offline'],
  [{ isConnected: true, isInternetReachable: true }, 'online'],
  [{ isConnected: true, isInternetReachable: null }, 'online'],
  [{ isConnected: null, isInternetReachable: null }, 'unknown'],
])('maps %j to %s', (state, expected) => {
  expect(reachability(state)).toBe(expected);
});

test('binaries without the native network module never block network actions', async () => {
  expect(createExpoNetwork()).toBe(unknownNetwork);
  expect(requireOptionalNativeModule).toHaveBeenCalledWith('ExpoNetwork');
  await expect(unknownNetwork.current()).resolves.toBe('unknown');
});
