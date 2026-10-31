jest.mock('react-native-drawer-layout', () => {
  const React = jest.requireActual('react');
  const progress = { value: 0 };
  return {
    Drawer: ({
      children,
      renderDrawerContent,
    }: {
      children: ReactNode;
      renderDrawerContent: () => ReactNode;
    }) => React.createElement(React.Fragment, null, children, renderDrawerContent()),
    DrawerProgressContext: React.createContext(progress),
    useDrawerProgress: () => progress,
  };
});
// The real drawer requires bridge clients; this double keeps that contract and mounts the
// drawer's profile row, the piece under test.
jest.mock('@shell/navigation/DrawerContent', () => ({
  DrawerContent: () => {
    const { useBridgeApi, useBridgeWs } = jest.requireActual('@shell/state/bridge/hooks');
    const { DrawerProfileRow } = jest.requireActual('@shell/profiles/ProfileSwitcher');
    useBridgeApi();
    useBridgeWs();
    return DrawerProfileRow({ styles: { row: {}, rowPressed: {}, label: {}, value: {} } });
  },
}));
// The workspace picker route is only navigated to here; its content has its own tests.
jest.mock('../../features/workspace/picker/Screen', () => ({ WorkspacePickerScreen: () => null }));
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('@shell/boot/AppShells', () => ({ ConnectionScreen: () => null }));

import { router, Stack, useGlobalSearchParams } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { PropsWithChildren, ReactNode } from 'react';
import { Text, View } from 'react-native';

import { LocalBridgeServer } from '../../features/on-device/transport/server';
import { FakeAgentPort } from '../../features/on-device/transport/testing';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { createDefaultAppStateData } from '@shell/state/appState';
import {
  activeProfileIdAtom,
  bridgeConnectedAtom,
  localProfileAvailableAtom,
} from '@shell/state/bridge/atoms';
import { localRuntimeAtom, localTransportAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { AppStateProvider } from '@shell/state/store';
import { createTestStore } from '@shell/state/testing';
import { useProfileRouteReady } from '@shell/navigation/ProfileRouteBoundary';
import { LOCAL_SETUP_DESTINATIONS } from './localSetup';
import { NewChatRunTarget } from './ProfileSwitcher';
import { createFakeSetupRuntime } from './testing';

function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

/** The new-chat screen with the real "where to run" control ComposeView mounts. */
function NewChatRoute() {
  const { profileId } = useGlobalSearchParams<{ profileId?: string }>();
  return useProfileRouteReady() ? (
    <View>
      <Text>New chat in {profileId}</Text>
      <NewChatRunTarget />
    </View>
  ) : null;
}

function LegacyModelsRoute() {
  return <Text>Model library</Text>;
}

function LegacyWorkspacesRoute() {
  return <Text>Workspaces</Text>;
}

function storeWith(available: boolean) {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = {
    activeProfileId: 'profile-1',
    profiles: [
      {
        id: 'profile-1',
        name: 'Desk',
        bridgeUrl: 'https://desk.test',
        bridgeToken: 'token',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const store = createTestStore({ data });
  store.set(localProfileAvailableAtom, available);
  store.set(bridgeConnectedAtom, true);
  return store;
}

function render(store: ReturnType<typeof storeWith>) {
  const Wrapper = ({ children }: PropsWithChildren) => (
    <AppStateProvider store={store}>{children}</AppStateProvider>
  );
  return renderRouter(
    {
      appDir: './src/app',
      overrides: {
        _layout: RootLayout,
        'profiles/[profileId]/(drawer)/chats/[chatId]/index': NewChatRoute,
        'on-device/models': LegacyModelsRoute,
        'on-device/workspaces': LegacyWorkspacesRoute,
      },
    },
    { initialUrl: '/profiles/profile-1/chats/new', wrapper: Wrapper },
  );
}

const MODEL = 'qwen3-1.7b-q4-k-m';

describe('profile switching', () => {
  it('switches a bridge chat to On this iPhone, guides setup, and switches back', async () => {
    const store = storeWith(true);
    const result = render(store);
    expect(screen.getByText('New chat in profile-1')).toBeTruthy();

    // New chat names where it runs and lists every profile with its state.
    fireEvent.press(screen.getByTestId('new-chat-profile-switcher'));
    expect(screen.getByLabelText('Desk').props['accessibilityHint']).toBe('Connected · desk.test');
    expect(screen.getByLabelText('On this iPhone').props['accessibilityHint']).toBe(
      'Private offline models',
    );
    expect(screen.getByLabelText('Add bridge')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('On this iPhone'));
    await waitFor(() => {
      expect(store.get(activeProfileIdAtom)).toBe(LOCAL_PROFILE_ID);
    });
    expect(result.getPathname()).toBe('/profiles/on-device/chats/new');

    // The runtime host publishes a runtime with nothing downloaded yet.
    const fake = createFakeSetupRuntime({
      modelId: MODEL,
      workspaceId: null,
      workspaces: [],
      downloadPhase: 'not_downloaded',
    });
    const transport = new LocalBridgeWsClient(new LocalBridgeServer(new FakeAgentPort()));
    transport.connect();
    act(() => {
      store.set(localRuntimeAtom, fake.runtime);
      store.set(localTransportAtom, transport);
    });
    expect(screen.getByText('New chat in on-device')).toBeTruthy();
    expect(screen.getByTestId('new-chat-profile-switcher').props['accessibilityLabel']).toBe(
      'Where agents run, On this iPhone, Needs a model · Private offline models',
    );
    expect(screen.getByTestId('local-setup-guide')).toBeTruthy();
    expect(screen.getByLabelText('1. Download a model, Required')).toBeTruthy();
    expect(screen.getByLabelText('2. Clone or create a workspace, Required')).toBeTruthy();

    act(() => fake.update({ downloadPhase: 'downloading' }));
    expect(screen.getByLabelText('1. Download a model, Downloading')).toBeTruthy();
    act(() => fake.update({ downloadPhase: 'ready' }));
    expect(screen.getByLabelText('1. Download a model, Done')).toBeTruthy();
    expect(screen.getByText('Choose or clone a workspace for the agent to work in.')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('2. Clone or create a workspace, Required'));
    expect(result.getPathname()).toBe('/profiles/on-device/chats/new/workspace-picker');
    act(() => {
      router.back();
    });
    await waitFor(() => {
      expect(result.getPathname()).toBe('/profiles/on-device/chats/new');
    });
    fireEvent.press(screen.getByLabelText('1. Download a model, Done'));
    expect(result.getPathname()).toBe(LOCAL_SETUP_DESTINATIONS.models);
    act(() => {
      router.back();
    });
    await waitFor(() => {
      expect(screen.getByText('New chat in on-device')).toBeTruthy();
    });

    act(() => fake.update({ workspaceId: 'w1', workspaces: [{ id: 'w1', name: 'demo' }] }));
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
    expect(screen.getByTestId('drawer-profile-switcher').props['accessibilityLabel']).toBe(
      'Where agents run, On this iPhone, Ready · Private offline models',
    );

    // The drawer switches back in two taps.
    fireEvent.press(screen.getByTestId('drawer-profile-switcher'));
    fireEvent.press(screen.getByLabelText('Desk'));
    await waitFor(() => {
      expect(store.get(activeProfileIdAtom)).toBe('profile-1');
    });
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/new');
    transport.dispose();
  });

  it('follows the first model download, which starts without selecting a model', async () => {
    const store = storeWith(true);
    render(store);
    const fake = createFakeSetupRuntime({
      modelId: null,
      workspaceId: 'w1',
      workspaces: [{ id: 'w1', name: 'demo' }],
      downloadPhase: 'not_downloaded',
      downloadPhases: {},
    });
    const transport = new LocalBridgeWsClient(new LocalBridgeServer(new FakeAgentPort()));
    transport.connect();
    act(() => {
      store.set(localRuntimeAtom, fake.runtime);
      store.set(localTransportAtom, transport);
    });
    fireEvent.press(screen.getByTestId('new-chat-profile-switcher'));
    fireEvent.press(screen.getByLabelText('On this iPhone'));
    await waitFor(() => {
      expect(screen.getByText('New chat in on-device')).toBeTruthy();
    });
    const switcher = () =>
      String(screen.getByTestId('new-chat-profile-switcher').props['accessibilityLabel']);
    expect(screen.getByLabelText('1. Download a model, Required')).toBeTruthy();
    expect(switcher()).toContain('Needs a model');

    act(() => fake.update({ downloadPhases: { [MODEL]: 'downloading' } }));
    expect(screen.getByLabelText('1. Download a model, Downloading')).toBeTruthy();
    expect(switcher()).toContain('Downloading model');

    act(() => fake.update({ downloadPhases: { [MODEL]: 'ready' } }));
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
    expect(switcher()).toBe('Where agents run, On this iPhone, Ready · Private offline models');
    transport.dispose();
  });

  it('offers no choice with a single bridge where the local agent is unavailable', () => {
    const store = storeWith(false);
    render(store);
    expect(screen.getByText('New chat in profile-1')).toBeTruthy();
    expect(screen.queryByTestId('new-chat-profile-switcher')).toBeNull();
    expect(screen.queryByTestId('drawer-profile-switcher')).toBeNull();
  });
});
