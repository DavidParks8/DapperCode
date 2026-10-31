jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../features/on-device/runtime/runtime', () => ({ OnDeviceRuntime: jest.fn() }));
jest.mock('../../features/on-device/runtime/expoNetwork', () => ({
  createExpoNetwork: () => ({}),
}));
jest.mock('../../features/on-device/native/services', () => ({
  getOnDeviceNativeServices: () => ({}),
}));
jest.mock('../../features/on-device/transport/runtimePort', () => {
  const { FakeAgentPort } = jest.requireActual('../../features/on-device/transport/testing');
  return { createRuntimeAgentPort: () => new FakeAgentPort() };
});
jest.mock('./localAgentPresence', () => ({
  LOCAL_PRESENCE_SLICES: [],
  describeLocalAgentPresence: () => ({
    status: { label: 'Ready', kind: 'ready' },
    readiness: null,
    defaultWorkspacePath: '/On this iPhone/Demo',
  }),
  sameLocalAgentPresence: () => true,
}));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import { createDefaultAppStateData } from '@shell/state/appState';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { localRuntimeAtom, localTransportAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createTestStore, withAppStore } from '@shell/state/testing';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { LocalRuntimeHost } from './LocalRuntimeHost';

function runtimeDouble(initialize: () => Promise<void>) {
  return {
    initialize: jest.fn(initialize),
    background: jest.fn(async () => undefined),
    foreground: jest.fn(async () => undefined),
    relieveMemory: jest.fn(async () => undefined),
    report: jest.fn(),
    dispose: jest.fn(async () => undefined),
    subscribe: jest.fn(() => () => undefined),
    version: jest.fn(() => 0),
    legacyDrafts: () => new Map(),
    issues: () => [],
    threads: { list: () => [] },
  };
}

function renderHost() {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = { activeProfileId: LOCAL_PROFILE_ID, profiles: [] };
  const store = createTestStore({ data });
  store.set(localProfileAvailableAtom, true);
  render(
    withAppStore(
      store,
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={createAppTheme('light')}>
          <LocalRuntimeHost />
        </AppThemeProvider>
      </SafeAreaProvider>,
    ),
  );
  return store;
}

beforeEach(() => {
  jest.mocked(OnDeviceRuntime).mockReset();
  act(() => router.replace('/profiles/on-device/chats/new'));
});

describe('LocalRuntimeRecovery', () => {
  it('leaves startup to the profile route, then recovers a failed start in the shared Settings style', async () => {
    let failStartup!: (error: Error) => void;
    const failed = runtimeDouble(
      () =>
        new Promise<void>((_resolve, reject) => {
          failStartup = reject;
        }),
    );
    const next = runtimeDouble(async () => undefined);
    jest
      .mocked(OnDeviceRuntime)
      .mockImplementationOnce(() => failed as unknown as OnDeviceRuntime)
      .mockImplementationOnce(() => next as unknown as OnDeviceRuntime);
    const store = renderHost();

    // Starting: the host draws nothing, so ProfileRouteBoundary's "Opening On this iPhone" shows.
    await waitFor(() => expect(failed.initialize).toHaveBeenCalled());
    expect(screen.queryByTestId('local-runtime-recovery')).toBeNull();
    expect(screen.queryByText('On this iPhone')).toBeNull();

    await act(async () => failStartup(new Error('Broken storage')));
    expect(await screen.findByTestId('local-runtime-recovery')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'On this iPhone' })).toBeTruthy();
    expect(screen.getByText('Broken storage')).toBeTruthy();
    expect(screen.getByRole('alert').props['accessibilityLiveRegion']).toBe('assertive');
    // Shared Settings rows, not the retired text pills with a "Back" control.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByLabelText('Back to Settings')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect a desktop instead' })).toBeTruthy();
    expect(store.get(localTransportAtom)).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Retry without resetting storage' }));
    await waitFor(() => expect(store.get(localTransportAtom)).not.toBeNull());
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    expect(store.get(localRuntimeAtom)).toBe(next);
    expect(screen.queryByTestId('local-runtime-recovery')).toBeNull();
  });
});
