import { getOnDeviceNativeServices } from './services.ios';
import {
  isOnDeviceNativeError,
  OnDeviceNativeError,
  toOnDeviceNativeError,
  withNativeErrorMapping,
} from './services.errors';
import { ON_DEVICE_NATIVE_API_VERSION } from './services.types';

const mockNativeLookup = jest.fn();
jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => mockNativeLookup(name),
}));

const RAW_AUDIT_FAILURE =
  'UnexpectedException: Paths must stay inside the workspace and outside Git metadata. (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)';

test('old native builds are rejected before exposing models requiring the updated engine', () => {
  mockNativeLookup.mockReturnValue({ getAPIVersion: () => ON_DEVICE_NATIVE_API_VERSION - 1 });
  expect(() => getOnDeviceNativeServices()).toThrow('Rebuild the native iOS app');
});

test('the current native build passes the version boundary with error mapping applied', async () => {
  const listWorkspaces = jest.fn(() => Promise.resolve([]));
  mockNativeLookup.mockReturnValue({
    getAPIVersion: () => ON_DEVICE_NATIVE_API_VERSION,
    listWorkspaces,
    listWorkspaceFiles: () =>
      Promise.reject(
        new Error(
          'UnexpectedException: [ondevice:PATH_OUTSIDE_WORKSPACE] Paths must stay inside the workspace and outside Git metadata. (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)',
        ),
      ),
  });
  const services = getOnDeviceNativeServices();
  expect(services.getAPIVersion()).toBe(ON_DEVICE_NATIVE_API_VERSION);
  await expect(services.listWorkspaces()).resolves.toEqual([]);
  expect(listWorkspaces).toHaveBeenCalledTimes(1);
  const failure = await services.listWorkspaceFiles('workspace', '', 200).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(OnDeviceNativeError);
  expect(failure).toMatchObject({
    code: 'PATH_OUTSIDE_WORKSPACE',
    message: 'Paths must stay inside the workspace and outside Git metadata.',
  });
});

test('tagged native failures keep their stable code and lose Expo exception decoration', () => {
  const error = toOnDeviceNativeError(
    new Error(
      'UnexpectedException: [ondevice:GIT_NOT_REPOSITORY] This workspace is not a Git repository. Initialize Git to track changes. (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)',
    ),
  );
  expect(error.code).toBe('GIT_NOT_REPOSITORY');
  expect(error.message).toBe(
    'This workspace is not a Git repository. Initialize Git to track changes.',
  );
  expect(isOnDeviceNativeError(error, 'GIT_NOT_REPOSITORY')).toBe(true);
  expect(isOnDeviceNativeError(error, 'GIT_CONFLICT')).toBe(false);
});

test('untagged native failures never surface exception names or Swift source locations', () => {
  const error = toOnDeviceNativeError(new Error(RAW_AUDIT_FAILURE));
  expect(error.code).toBe('NATIVE_FAILURE');
  expect(error.message).toBe('Paths must stay inside the workspace and outside Git metadata.');
  expect(error.message).not.toMatch(/Exception|ExpoModulesCore|\.swift/);
  const chained = toOnDeviceNativeError(
    new Error(
      "FunctionCallException: Calling the 'readWorkspaceFile' function has failed (at ExpoModulesCore/AsyncFunctionDefinition.swift:12)\n→ Caused by: The file “a.txt” couldn’t be opened (POSIX error 2).",
    ),
  );
  expect(chained.message).toBe('The file “a.txt” couldn’t be opened (POSIX error 2).');
  const tagChain = toOnDeviceNativeError(
    new Error(
      "FunctionCallException: Calling the 'pullWorkspaceGit' function has failed\n→ Caused by: [ondevice:GIT_NON_FAST_FORWARD] This branch and its upstream have diverged.",
    ),
  );
  expect(tagChain).toMatchObject({
    code: 'GIT_NON_FAST_FORWARD',
    message: 'This branch and its upstream have diverged.',
  });
  expect(toOnDeviceNativeError('[ondevice:FUTURE_CODE] Something new.')).toMatchObject({
    code: 'NATIVE_FAILURE',
    message: 'Something new.',
  });
  expect(toOnDeviceNativeError(undefined).message).toBe('The on-device operation failed.');
});

test('synchronous native throws are mapped and values pass through unchanged', () => {
  const services = withNativeErrorMapping({
    version: 7,
    getMemoryInfo: () => {
      throw new Error('UnexpectedException: [ondevice:STORAGE_FAILURE] Memory unavailable.');
    },
    echo: (value: string) => value,
  });
  expect(services.version).toBe(7);
  expect(services.echo('value')).toBe('value');
  expect(() => services.getMemoryInfo()).toThrow(
    expect.objectContaining({ code: 'STORAGE_FAILURE', message: 'Memory unavailable.' }),
  );
});
