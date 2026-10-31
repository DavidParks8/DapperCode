import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';
import type * as ReactNative from 'react-native';
import { OnDeviceProvider } from './OnDeviceProvider';
import { OnDeviceRuntime } from './runtime';

jest.mock('./runtime', () => ({ OnDeviceRuntime: jest.fn() }));
jest.mock('./expoNetwork', () => ({ createExpoNetwork: () => ({}) }));
jest.mock('../native/services', () => ({ getOnDeviceNativeServices: () => ({}) }));
jest.mock('../screens/ui', () => {
  const {
    Pressable,
    Text: MockText,
    View,
  } = jest.requireActual<typeof ReactNative>('react-native');
  return {
    LocalPage: ({ children, error }: { children?: React.ReactNode; error?: string | null }) => (
      <View>
        {error ? <MockText>{error}</MockText> : null}
        {children}
      </View>
    ),
    LocalText: ({ children }: { children?: React.ReactNode }) => <MockText>{children}</MockText>,
    LocalAction: ({ title, onPress }: { title: string; onPress: () => void }) => (
      <Pressable onPress={onPress}>
        <MockText>{title}</MockText>
      </Pressable>
    ),
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function runtimeDouble(initialize: () => Promise<void> = async () => undefined) {
  return {
    initialize: jest.fn(initialize),
    background: jest.fn(async () => undefined),
    foreground: jest.fn(async () => undefined),
    relieveMemory: jest.fn(async () => undefined),
    report: jest.fn(),
    dispose: jest.fn((): Promise<void> => Promise.resolve()),
    subscribe: jest.fn(() => () => undefined),
    version: jest.fn(() => 0),
  };
}

const handlers = new Map<string, (state?: AppStateStatus) => void>();

beforeEach(() => {
  handlers.clear();
  jest.mocked(OnDeviceRuntime).mockReset();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    handlers.set(type, handler as (state?: AppStateStatus) => void);
    return { remove: jest.fn() };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('only a real background transition suspends local work; returning to active resumes it', async () => {
  const runtime = runtimeDouble();
  jest.mocked(OnDeviceRuntime).mockImplementation(() => runtime as unknown as OnDeviceRuntime);
  render(
    <OnDeviceProvider>
      <Text>ready</Text>
    </OnDeviceProvider>,
  );
  await screen.findByText('ready');
  // Starting while active counts as becoming active, which resumes interrupted downloads.
  expect(runtime.foreground).toHaveBeenCalledTimes(1);
  const change = (state: AppStateStatus) => act(() => handlers.get('change')?.(state));
  change('inactive');
  change('active');
  expect(runtime.background).not.toHaveBeenCalled();
  expect(runtime.foreground).toHaveBeenCalledTimes(1);
  change('inactive');
  change('background');
  expect(runtime.background).toHaveBeenCalledTimes(1);
  change('inactive');
  change('active');
  expect(runtime.foreground).toHaveBeenCalledTimes(2);
  act(() => handlers.get('memoryWarning')?.());
  expect(runtime.relieveMemory).toHaveBeenCalledTimes(1);
  expect(runtime.background).toHaveBeenCalledTimes(1);
});

test('retry waits for the failed runtime to finish disposing before constructing another', async () => {
  const disposal = deferred();
  const failed = runtimeDouble(() => Promise.reject(new Error('Broken storage')));
  failed.dispose.mockImplementation(() => disposal.promise);
  const next = runtimeDouble();
  jest
    .mocked(OnDeviceRuntime)
    .mockImplementationOnce(() => failed as unknown as OnDeviceRuntime)
    .mockImplementationOnce(() => next as unknown as OnDeviceRuntime);
  render(
    <OnDeviceProvider>
      <Text>ready</Text>
    </OnDeviceProvider>,
  );
  fireEvent.press(await screen.findByText('Retry without resetting storage'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(failed.dispose).toHaveBeenCalledTimes(1);
  expect(OnDeviceRuntime).toHaveBeenCalledTimes(1);
  await act(async () => {
    disposal.resolve();
    await disposal.promise;
  });
  await screen.findByText('ready');
  expect(OnDeviceRuntime).toHaveBeenCalledTimes(2);
});

test('a remounted provider starts its runtime only after the previous one finishes starting and disposing', async () => {
  const startup = deferred();
  const first = runtimeDouble(() => startup.promise);
  first.dispose.mockImplementation(() => startup.promise);
  const second = runtimeDouble();
  jest
    .mocked(OnDeviceRuntime)
    .mockImplementationOnce(() => first as unknown as OnDeviceRuntime)
    .mockImplementationOnce(() => second as unknown as OnDeviceRuntime);
  const view = render(
    <OnDeviceProvider>
      <Text>ready</Text>
    </OnDeviceProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  view.unmount();
  render(
    <OnDeviceProvider>
      <Text>ready</Text>
    </OnDeviceProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(first.dispose).toHaveBeenCalledTimes(1);
  expect(OnDeviceRuntime).toHaveBeenCalledTimes(1);
  await act(async () => {
    startup.resolve();
    await startup.promise;
  });
  await screen.findByText('ready');
  expect(OnDeviceRuntime).toHaveBeenCalledTimes(2);
  expect(second.initialize).toHaveBeenCalledTimes(1);
});

test('starting in the background suspends instead of resuming downloads', async () => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
  const runtime = runtimeDouble();
  jest.mocked(OnDeviceRuntime).mockImplementation(() => runtime as unknown as OnDeviceRuntime);
  render(
    <OnDeviceProvider>
      <Text>ready</Text>
    </OnDeviceProvider>,
  );
  await screen.findByText('ready');
  expect(runtime.background).toHaveBeenCalledTimes(1);
  expect(runtime.foreground).not.toHaveBeenCalled();
  act(() => handlers.get('change')?.('active'));
  expect(runtime.foreground).toHaveBeenCalledTimes(1);
});
