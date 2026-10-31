import { requireOptionalNativeModule } from 'expo';
import { createExpoNetwork } from './expoNetwork';
import { NetworkMonitor, reachability, unknownNetwork } from './network';

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

test('a monitor closed before it starts never registers a listener', async () => {
  const port = { current: jest.fn(async () => 'online' as const), subscribe: jest.fn() };
  const changed = jest.fn();
  const monitor = new NetworkMonitor(port, changed);
  monitor.close();
  await monitor.start();
  expect(port.subscribe).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});
