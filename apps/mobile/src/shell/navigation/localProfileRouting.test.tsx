import { router, Stack, useGlobalSearchParams } from 'expo-router';
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
// The real drawer requires bridge clients; this double keeps that contract without its UI.
jest.mock('@shell/navigation/DrawerContent', () => ({
  DrawerContent: () => {
    const { useBridgeApi, useBridgeWs } = jest.requireActual('@shell/state/bridge/hooks');
    useBridgeApi();
    useBridgeWs();
    return null;
  },
}));
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('@shell/boot/AppShells', () => ({ ConnectionScreen: () => null }));

import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { PropsWithChildren, ReactNode } from 'react';
import { Text } from 'react-native';

import { LocalBridgeServer } from '../../features/on-device/transport/server';
import { FakeAgentPort } from '../../features/on-device/transport/testing';
import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { createDefaultAppStateData } from '@shell/state/appState';
import {
  activeProfileAtom,
  activeProfileIdAtom,
  apiClientAtom,
  localProfileAvailableAtom,
  wsClientAtom,
} from '@shell/state/bridge/atoms';
import { localRuntimeAtom, localTransportAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE, LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { AppStateProvider } from '@shell/state/store';
import { createTestStore } from '@shell/state/testing';
import { useProfileRouteReady } from '@shell/navigation/ProfileRouteBoundary';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { routes } from '@shell/navigation/routes';

function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

function ReadyMainRoute() {
  const { profileId, chatId } = useGlobalSearchParams<{ profileId?: string; chatId?: string }>();
  return useProfileRouteReady() ? (
    <Text>
      Main {profileId} {chatId}
    </Text>
  ) : null;
}

function storeWith(activeProfileId: string, available: boolean) {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = {
    activeProfileId,
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
  return store;
}

function render(store: ReturnType<typeof storeWith>, initialUrl: string) {
  const Wrapper = ({ children }: PropsWithChildren) => (
    <AppStateProvider store={store}>{children}</AppStateProvider>
  );
  return renderRouter(
    {
      appDir: './src/app',
      overrides: {
        _layout: RootLayout,
        'profiles/[profileId]/(drawer)/chats/[chatId]/index': ReadyMainRoute,
        'on-device/models': () => <Text>Model library</Text>,
      },
    },
    { initialUrl, wrapper: Wrapper },
  );
}

describe('local profile routing', () => {
  it('opens On this iPhone in the regular profile routes once its transport is ready', async () => {
    const store = storeWith('profile-1', true);
    const result = render(store, '/profiles/profile-1/chats/new');
    expect(screen.getByText('Main profile-1 new')).toBeTruthy();

    act(() => replaceRoot(routes.newChat(LOCAL_PROFILE_ID)));
    await waitFor(() => {
      expect(store.get(activeProfileAtom)).toEqual(LOCAL_PROFILE);
    });
    expect(result.getPathname()).toBe('/profiles/on-device/chats/new');
    // The chat waits for the shell's runtime host to publish the local transport.
    expect(screen.queryByText(/^Main/u)).toBeNull();
    expect(screen.getByLabelText('Opening On this iPhone')).toBeTruthy();

    const transport = new LocalBridgeWsClient(new LocalBridgeServer(new FakeAgentPort()));
    transport.connect();
    act(() => store.set(localTransportAtom, transport));
    expect(screen.getByText('Main on-device new')).toBeTruthy();
    expect(store.get(wsClientAtom)).toBe(transport);
    expect(store.get(apiClientAtom)?.profileId).toBe(LOCAL_PROFILE_ID);

    act(() => replaceRoot(routes.newChat('profile-1')));
    await waitFor(() => {
      expect(store.get(activeProfileIdAtom)).toBe('profile-1');
    });
    expect(store.get(wsClientAtom)).not.toBe(transport);
    transport.dispose();
  });

  it('never resolves a saved local selection where the local agent is unsupported', async () => {
    const store = storeWith(LOCAL_PROFILE_ID, false);
    expect(store.get(activeProfileAtom)).toBeNull();
    const result = render(store, '/');
    await waitFor(() => {
      expect(result.getPathname()).toBe('/profiles/profile-1/chats/new');
    });
    await waitFor(() => {
      expect(store.get(activeProfileIdAtom)).toBe('profile-1');
    });
  });

  it('explains instead of opening a local profile link on an unsupported device', () => {
    const store = storeWith('profile-1', false);
    render(store, '/profiles/on-device/chats/new');
    expect(screen.getByText('On this iPhone is unavailable')).toBeTruthy();
  });

  it('redirects the legacy on-device hub and chat links into the unified shell', async () => {
    const store = storeWith(LOCAL_PROFILE_ID, true);
    store.set(localRuntimeAtom, {} as OnDeviceRuntime);
    const hub = render(store, '/on-device');
    await waitFor(() => {
      expect(hub.getPathname()).toBe('/profiles/on-device/chats/new');
    });
    hub.unmount();
    const chat = render(store, '/on-device/chat/thread-7');
    await waitFor(() => {
      expect(chat.getPathname()).toBe('/profiles/on-device/chats/thread-7');
    });
  });

  it('keeps a switched profile after returning from a screen outside the profile', async () => {
    const store = storeWith('profile-1', true);
    store.set(localRuntimeAtom, {} as OnDeviceRuntime);
    const transport = new LocalBridgeWsClient(new LocalBridgeServer(new FakeAgentPort()));
    transport.connect();
    store.set(localTransportAtom, transport);
    const result = render(store, '/profiles/profile-1/chats/new');

    act(() => replaceRoot(routes.newChat(LOCAL_PROFILE_ID)));
    await waitFor(() => {
      expect(screen.getByText('Main on-device new')).toBeTruthy();
    });
    act(() => router.push('/on-device/models'));
    expect(screen.getByText('Model library')).toBeTruthy();
    act(() => router.back());

    await waitFor(() => {
      expect(screen.getByText('Main on-device new')).toBeTruthy();
    });
    expect(result.getPathname()).toBe('/profiles/on-device/chats/new');
    expect(store.get(activeProfileIdAtom)).toBe(LOCAL_PROFILE_ID);
    transport.dispose();
  });
});
