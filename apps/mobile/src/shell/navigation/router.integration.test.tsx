import { Stack, router, useGlobalSearchParams, useLocalSearchParams } from 'expo-router';
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
jest.mock('@shell/navigation/DrawerContent', () => ({ DrawerContent: () => null }));
jest.mock('react-native-webview', () => ({ WebView: () => null }));

let mockConnectionScreenProps: Record<string, unknown> | null = null;
jest.mock('@shell/boot/AppShells', () => ({
  ConnectionScreen: (props: Record<string, unknown>) => {
    mockConnectionScreenProps = props;
    return null;
  },
}));

import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import {
  useEffect,
  useState,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { Text } from 'react-native';

import { createDefaultAppStateData } from '@shell/state/appState';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { AppStateProvider } from '@shell/state/store';
import { createTestStore } from '@shell/state/testing';
import { navigateRoot, replaceRoot } from '@shell/navigation/routeNavigation';
import { routes } from '@shell/navigation/routes';
import { usePromoteNewChatRoute } from '@shell/navigation/usePromoteNewChatRoute';
import { useProfileRouteReady } from '@shell/navigation/ProfileRouteBoundary';
import { navigateAtom, openBrowserAtom } from '@shell/navigation/actions';
import { selectedChatIdAtom } from '@shell/state/chat/atoms';
import { BrowserChatReturn } from '../../features/browser/screen/TopSections';

const mainLifecycle: string[] = [];
const mainRenders: string[] = [];
let promoteChat: ((chatId: string) => void) | null = null;
let defaultWrapper: ComponentType<PropsWithChildren>;
let navigationStore: ReturnType<typeof createTestStore>;

function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

function MainRoute() {
  const { chatId = 'missing' } = useGlobalSearchParams<{ chatId?: string }>();
  mainRenders.push(chatId);
  useEffect(() => {
    mainLifecycle.push('mount');
    return () => {
      mainLifecycle.push('unmount');
    };
  }, []);
  return <Text>Main chat {chatId}</Text>;
}

function ReadyMainRoute() {
  return useProfileRouteReady() ? <MainRoute /> : null;
}

function PromotingMainRoute() {
  const { chatId = 'new' } = useLocalSearchParams<{ chatId?: string }>();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  promoteChat = setSelectedChatId;
  usePromoteNewChatRoute(chatId, selectedChatId);
  return <MainRoute />;
}

function GitRoute() {
  return <Text>Git detail</Text>;
}

function AgentRoute() {
  const { threadId } = useGlobalSearchParams<{ threadId?: string }>();
  return <Text>Agent {threadId}</Text>;
}

function ConnectionRoute() {
  return <Text>Connection</Text>;
}

const formLifecycle: string[] = [];

function FormDraftRoute() {
  useEffect(() => {
    formLifecycle.push('mount');
    return () => {
      formLifecycle.push('unmount');
    };
  }, []);
  return <Text>Connection form draft</Text>;
}

const routeLabels = {
  agent: 'Agent route',
  browser: 'Browser route',
  checkout: 'Checkout route',
  connection: 'Connection route',
  settingsConnection: 'Settings connection route',
  git: 'Git route',
  privacy: 'Privacy route',
  settings: 'Settings route',
  terms: 'Terms route',
  workspace: 'Workspace route',
} as const;

const routeOverrides = {
  'profiles/[profileId]/(drawer)/browser': () => <Text>{routeLabels.browser}</Text>,
  'profiles/[profileId]/(drawer)/settings/index': () => <Text>{routeLabels.settings}</Text>,
  'profiles/[profileId]/(drawer)/settings/privacy': () => <Text>{routeLabels.privacy}</Text>,
  'profiles/[profileId]/(drawer)/settings/terms': () => <Text>{routeLabels.terms}</Text>,
  'profiles/[profileId]/(drawer)/settings/connection': () => (
    <Text>{routeLabels.settingsConnection}</Text>
  ),
  'profiles/[profileId]/(drawer)/chats/[chatId]/git': () => <Text>{routeLabels.git}</Text>,
  'profiles/[profileId]/(drawer)/chats/[chatId]/agents/[threadId]': () => (
    <Text>{routeLabels.agent}</Text>
  ),
  'profiles/[profileId]/(drawer)/chats/[chatId]/workspace-picker': () => (
    <Text>{routeLabels.workspace}</Text>
  ),
  'profiles/[profileId]/(drawer)/chats/[chatId]/git-checkout': () => (
    <Text>{routeLabels.checkout}</Text>
  ),
  'profiles/[profileId]/(drawer)/chats/[chatId]/connection': () => (
    <Text>{routeLabels.connection}</Text>
  ),
};

function SettingsConnectionLauncher() {
  const { profileId = 'profile-1' } = useLocalSearchParams<{
    profileId?: string;
  }>();
  useEffect(() => {
    router.push(routes.settingsConnection(profileId, 'edit'));
  }, [profileId]);
  return <Text>Settings launcher</Text>;
}

function ChatFooterConnectionLauncher() {
  const { profileId = 'profile-1', chatId = 'missing' } = useLocalSearchParams<{
    profileId?: string;
    chatId?: string;
  }>();
  mainRenders.push(chatId);
  useEffect(() => {
    mainLifecycle.push('mount');
    return () => {
      mainLifecycle.push('unmount');
    };
  }, []);
  useEffect(() => {
    // Mirrors openBridgeConnectionAtom in actions.ts: the drawer's connection footer opens the
    // Settings-owned connection editor with an anchored push, from whatever screen (a chat, in
    // this case) the drawer happened to be opened over.
    router.push(routes.settingsConnection(profileId, 'edit'), { withAnchor: true });
  }, [profileId]);
  return <Text>Chat {chatId}</Text>;
}

const baseOverrides = {
  _layout: RootLayout,
};

function countNamedRoutes(state: unknown, routeName: string): number {
  if (!state || typeof state !== 'object') {
    return 0;
  }
  const routesValue = (state as { routes?: unknown }).routes;
  if (!Array.isArray(routesValue)) {
    return 0;
  }
  return routesValue.reduce((count, route) => {
    if (!route || typeof route !== 'object') {
      return count;
    }
    const record = route as { name?: unknown; state?: unknown };
    return count + (record.name === routeName ? 1 : 0) + countNamedRoutes(record.state, routeName);
  }, 0);
}

function findStackContaining(
  state: unknown,
  routeName: string,
): { routes: Array<{ name?: unknown }> } | null {
  if (!state || typeof state !== 'object') {
    return null;
  }
  const routesValue = (state as { routes?: unknown }).routes;
  if (!Array.isArray(routesValue)) {
    return null;
  }
  if (routesValue.some((route) => (route as { name?: unknown }).name === routeName)) {
    return state as { routes: Array<{ name?: unknown }> };
  }
  for (const route of routesValue) {
    const found = findStackContaining((route as { state?: unknown }).state, routeName);
    if (found) {
      return found;
    }
  }
  return null;
}

describe('Expo Router route topology', () => {
  beforeEach(() => {
    mainLifecycle.length = 0;
    mainRenders.length = 0;
    formLifecycle.length = 0;
    promoteChat = null;
    mockConnectionScreenProps = null;
    const data = createDefaultAppStateData();
    data.bridgeProfiles = {
      activeProfileId: 'profile-1',
      profiles: [
        {
          id: 'profile-1',
          name: 'One',
          bridgeUrl: 'https://one.test',
          bridgeToken: 'one',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const store = createTestStore({ data });
    navigationStore = store;
    defaultWrapper = ({ children }: PropsWithChildren) => (
      <AppStateProvider store={store}>{children}</AppStateProvider>
    );
  });

  it('reconstructs the real anchored chat Stack beneath a cold Git deep link', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/chats/[chatId]/git': GitRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1/git',
        wrapper: defaultWrapper,
      },
    );

    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1/git');
    expect(screen.getByText('Git detail')).toBeTruthy();
    expect(mainLifecycle).toEqual(['mount']);
    expect(router.canGoBack()).toBe(true);
  });

  it('promotes a new chat id in place without remounting MainScreen', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': PromotingMainRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/new',
        wrapper: defaultWrapper,
      },
    );

    act(() => promoteChat?.('chat-created'));

    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-created');
    expect(mainLifecycle).toEqual(['mount']);
  });

  it('collapses pushed agents before switching chats and keeps one MainScreen', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/chats/[chatId]/agents/[threadId]': AgentRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1',
        wrapper: defaultWrapper,
      },
    );

    act(() => router.push('/profiles/profile-1/chats/chat-1/agents/child'));
    expect(screen.getByText('Agent child')).toBeTruthy();

    act(() => navigateRoot(routes.chat('profile-1', 'chat-2')));

    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-2');
    expect(mainLifecycle).toEqual(['mount']);
    expect(mainRenders).toContain('chat-2');
    expect(countNamedRoutes(result.getRouterState(), 'index')).toBe(1);
  });

  it.each([
    ['/profiles/profile-1/browser', routeLabels.browser],
    ['/profiles/profile-1/settings', routeLabels.settings],
    ['/profiles/profile-1/settings/privacy', routeLabels.privacy],
    ['/profiles/profile-1/settings/terms', routeLabels.terms],
    ['/profiles/profile-1/settings/connection?mode=edit', routeLabels.settingsConnection],
    ['/profiles/profile-1/chats/chat-1/git', routeLabels.git],
    ['/profiles/profile-1/chats/chat-1/agents/child', routeLabels.agent],
    ['/profiles/profile-1/chats/chat-1/workspace-picker', routeLabels.workspace],
    ['/profiles/profile-1/chats/chat-1/git-checkout', routeLabels.checkout],
    ['/profiles/profile-1/chats/chat-1/connection?mode=edit', routeLabels.connection],
  ])('cold-loads %s', (initialUrl, label) => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          ...routeOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': ReadyMainRoute,
        },
      },
      { initialUrl, wrapper: defaultWrapper },
    );

    expect(result.getPathname()).toBe(initialUrl.split('?')[0]);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('navigates every destination and returns through the intended history', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          ...routeOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': ReadyMainRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1',
        wrapper: defaultWrapper,
      },
    );

    act(() => navigateRoot(routes.browser('profile-1')));
    expect(screen.getByText(routeLabels.browser)).toBeTruthy();
    act(() => router.back());
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');

    act(() => navigateRoot(routes.settings('profile-1')));
    act(() => router.push(routes.privacy('profile-1')));
    expect(screen.getByText(routeLabels.privacy)).toBeTruthy();
    act(() => router.back());
    expect(screen.getByText(routeLabels.settings)).toBeTruthy();
    act(() => router.push(routes.terms('profile-1')));
    expect(screen.getByText(routeLabels.terms)).toBeTruthy();
    act(() => router.back());
    act(() => router.back());
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');

    for (const [href, label] of [
      [routes.workspacePicker('profile-1', 'chat-1'), routeLabels.workspace],
      [routes.gitCheckout('profile-1', 'chat-1'), routeLabels.checkout],
      [routes.git('profile-1', 'chat-1'), routeLabels.git],
      [routes.agent('profile-1', 'chat-1', 'child'), routeLabels.agent],
    ] as const) {
      act(() => router.push(href));
      expect(screen.getByText(label)).toBeTruthy();
      act(() => router.back());
      expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');
    }

    expect(router.canGoBack()).toBe(false);
    expect(mainLifecycle).toEqual(['mount']);
  });

  it.each([undefined, 'grandchild'])(
    'returns from a chat preview in one tap without remounting or losing nested history (%s)',
    (threadId) => {
      navigationStore.set(selectedChatIdAtom, 'chat-1');
      const result = renderRouter(
        {
          appDir: './src/app',
          overrides: {
            ...baseOverrides,
            'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
            'profiles/[profileId]/(drawer)/chats/[chatId]/agents/[threadId]': AgentRoute,
            'profiles/[profileId]/(drawer)/browser': BrowserChatReturn,
          },
        },
        { initialUrl: '/profiles/profile-1/chats/chat-1', wrapper: defaultWrapper },
      );
      if (threadId) {
        act(() => router.push(routes.agent('profile-1', 'chat-1', 'child')));
        act(() => router.push(routes.agent('profile-1', 'chat-1', threadId)));
      }
      const sourcePath = result.getPathname();
      for (let visit = 0; visit < 2; visit += 1) {
        act(() => navigationStore.set(openBrowserAtom, 'http://localhost:3000', threadId));
        expect(result.getPathname()).toBe('/profiles/profile-1/browser');
        fireEvent.press(screen.getByRole('button', { name: 'Back to chat' }));
        expect(result.getPathname()).toBe(sourcePath);
        expect(mainLifecycle).toEqual(['mount']);
      }
      if (threadId) {
        act(() => router.back());
        expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1/agents/child');
      }

      act(() => navigationStore.set(navigateAtom, 'Browser'));
      expect(result.getPathname()).toBe('/profiles/profile-1/browser');
      expect(screen.queryByRole('button', { name: 'Back to chat' })).toBeNull();
    },
  );

  it('can return to the source chat from a cold browser URL without navigation history', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/browser': BrowserChatReturn,
        },
      },
      {
        initialUrl: '/profiles/profile-1/browser?returnChatId=chat-1',
        wrapper: defaultWrapper,
      },
    );
    fireEvent.press(screen.getByRole('button', { name: 'Back to chat' }));
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');
  });

  it('pushes nested agents and returns one level at a time without remounting MainScreen', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/chats/[chatId]/agents/[threadId]': AgentRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1',
        wrapper: defaultWrapper,
      },
    );

    act(() => {
      router.push('/profiles/profile-1/chats/chat-1/agents/child');
      router.push('/profiles/profile-1/chats/chat-1/agents/grandchild');
    });
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1/agents/grandchild');
    expect(screen.getByText('Agent grandchild')).toBeTruthy();
    expect(mainLifecycle).toEqual(['mount']);

    act(() => router.back());
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1/agents/child');
    expect(screen.getByText('Agent child')).toBeTruthy();
    expect(mainLifecycle).toEqual(['mount']);
  });

  it('activates a live profile URL change once and clears the previous profile history', async () => {
    const data = createDefaultAppStateData();
    data.bridgeProfiles = {
      activeProfileId: 'profile-1',
      profiles: [
        {
          id: 'profile-1',
          name: 'One',
          bridgeUrl: 'https://one.test',
          bridgeToken: 'one',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'profile-2',
          name: 'Two',
          bridgeUrl: 'https://two.test',
          bridgeToken: 'two',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    };
    const store = createTestStore({ data });
    const Wrapper = ({ children }: PropsWithChildren) => (
      <AppStateProvider store={store}>{children}</AppStateProvider>
    );
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          _layout: RootLayout,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': ReadyMainRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1',
        wrapper: Wrapper,
      },
    );

    act(() => replaceRoot(routes.newChat('profile-2')));

    await waitFor(() => {
      expect(store.get(activeBridgeProfileAtom)?.id).toBe('profile-2');
    });
    expect(result.getPathname()).toBe('/profiles/profile-2/chats/new');
    expect(screen.getByText(/Main chat/)).toBeTruthy();
    expect(countNamedRoutes(result.getRouterState(), 'agents/[threadId]')).toBe(0);
  });

  it('uses the real profile anchor behind a cold connection modal', () => {
    const data = createDefaultAppStateData();
    data.bridgeProfiles = {
      activeProfileId: 'profile-1',
      profiles: [
        {
          id: 'profile-1',
          name: 'One',
          bridgeUrl: 'https://one.test',
          bridgeToken: 'one',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const store = createTestStore({ data });
    const Wrapper = ({ children }: PropsWithChildren) => (
      <AppStateProvider store={store}>{children}</AppStateProvider>
    );
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          _layout: RootLayout,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': ReadyMainRoute,
          'profiles/[profileId]/(drawer)/chats/[chatId]/connection': ConnectionRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1/connection?mode=edit',
        wrapper: Wrapper,
      },
    );

    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1/connection');
    expect(screen.getByText('Connection')).toBeTruthy();
    expect(router.canGoBack()).toBe(true);
    act(() => router.back());
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');
  });

  it('anchors the connection modal beneath Settings, not the currently selected chat', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/settings/connection': ConnectionRoute,
          'profiles/[profileId]/(drawer)/settings/index': SettingsConnectionLauncher,
        },
      },
      {
        initialUrl: '/profiles/profile-1/settings?chatId=chat-1',
        wrapper: defaultWrapper,
      },
    );

    expect(result.getPathname()).toBe('/profiles/profile-1/settings/connection');
    expect(screen.getByText('Connection')).toBeTruthy();
    // Settings never mounted a chat behind the modal, so there is nothing to leak into.
    expect(mainLifecycle).toEqual([]);
    act(() => router.back());
    // Cancelling/back must land on Settings, never on chats/new or any chat.
    expect(result.getPathname()).toBe('/profiles/profile-1/settings');
  });

  it('anchors the connection modal beneath Settings from a chat screen, keeping the chat intact', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': ChatFooterConnectionLauncher,
          'profiles/[profileId]/(drawer)/settings/connection': ConnectionRoute,
          'profiles/[profileId]/(drawer)/settings/index': () => <Text>{routeLabels.settings}</Text>,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1',
        wrapper: defaultWrapper,
      },
    );

    // openBridgeConnectionAtom's anchored push from the drawer footer must land on the modal
    // even when opened from a chat screen, not just from Settings itself.
    expect(result.getPathname()).toBe('/profiles/profile-1/settings/connection');
    expect(screen.getByText('Connection')).toBeTruthy();
    expect(mainLifecycle).toEqual(['mount']);

    // The anchor must force Settings' own `index` route to be established beneath the modal in
    // the very same stack — proving `POP_TO`'s destructive replace-when-absent behavior (see
    // routeNavigation.ts) never fires for this push.
    const settingsStack = findStackContaining(result.getRouterState(), 'connection');
    expect(settingsStack?.routes.map((route) => route.name)).toEqual(
      expect.arrayContaining(['index', 'connection']),
    );

    act(() => router.back());
    // Cancelling must land on Settings, never back on the originating chat or chats/new.
    expect(result.getPathname()).toBe('/profiles/profile-1/settings');
    expect(screen.getByText(routeLabels.settings)).toBeTruthy();

    // The chat the drawer was opened from must still be intact and reachable, not remounted.
    act(() => router.push('/profiles/profile-1/chats/chat-1'));
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');
    expect(mainLifecycle).toEqual(['mount']);
  });

  it('uses real Drawer history so chat root exits and Settings returns to the live chat', () => {
    const data = createDefaultAppStateData();
    data.bridgeProfiles = {
      activeProfileId: 'profile-1',
      profiles: [
        {
          id: 'profile-1',
          name: 'One',
          bridgeUrl: 'https://one.test',
          bridgeToken: 'one',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const store = createTestStore({ data });
    const Wrapper = ({ children }: PropsWithChildren) => (
      <AppStateProvider store={store}>{children}</AppStateProvider>
    );
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          _layout: RootLayout,
          'profiles/[profileId]/_layout': RootLayout,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/settings/index': () => <Text>Settings</Text>,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-2',
        wrapper: Wrapper,
      },
    );

    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-2');
    expect(router.canGoBack()).toBe(false);

    act(() => navigateRoot(routes.settings('profile-1')));
    expect(result.getPathname()).toBe('/profiles/profile-1/settings');
    expect(screen.getByText('Settings')).toBeTruthy();

    act(() => router.back());
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-2');

    act(() => navigateRoot(routes.chat('profile-1', 'chat-3')));
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-3');
    expect(mainLifecycle).toEqual(['mount']);
  });

  it('preserves an unrelated Settings push (e.g. Privacy) when root navigation lands on a completely different destination', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          ...routeOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1',
        wrapper: defaultWrapper,
      },
    );

    act(() => navigateRoot(routes.settings('profile-1')));
    act(() => router.push(routes.privacy('profile-1')));
    expect(screen.getByText(routeLabels.privacy)).toBeTruthy();
    expect(countNamedRoutes(result.getRouterState(), 'privacy')).toBe(1);

    // Root navigation to a destination that has nothing to do with Settings (e.g. a push
    // notification opening a chat) must not reach into Settings' own Stack and collapse the
    // Privacy screen the user left pushed there.
    act(() => navigateRoot(routes.chat('profile-1', 'chat-1')));
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');
    expect(countNamedRoutes(result.getRouterState(), 'privacy')).toBe(1);

    // Genuine back navigation into Settings' own history (not another root "land here"
    // request) still reveals the preserved Privacy screen.
    act(() => router.back());
    expect(screen.getByText(routeLabels.privacy)).toBeTruthy();
  });

  it('preserves an unsaved connection form in the background when an unrelated root navigation happens elsewhere', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/settings/index': () => <Text>{routeLabels.settings}</Text>,
          'profiles/[profileId]/(drawer)/settings/connection': FormDraftRoute,
        },
      },
      {
        initialUrl: '/profiles/profile-1/settings/connection?mode=add',
        wrapper: defaultWrapper,
      },
    );

    expect(result.getPathname()).toBe('/profiles/profile-1/settings/connection');
    expect(formLifecycle).toEqual(['mount']);
    expect(countNamedRoutes(result.getRouterState(), 'connection')).toBe(1);

    // Simulate an unrelated root navigation elsewhere (e.g. a push notification opening a
    // chat) while the user has an in-progress, unsaved "Add bridge" form open. The destination
    // has nothing to do with Settings, so it must never reach into Settings' own Stack.
    act(() => navigateRoot(routes.chat('profile-1', 'chat-1')));
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');

    // The unsaved form is still there in the background — its screen was never dismissed or
    // remounted, only the Drawer's focus moved away.
    expect(countNamedRoutes(result.getRouterState(), 'connection')).toBe(1);
    expect(formLifecycle).toEqual(['mount']);
  });

  it('unwinds the Settings connection modal on Save before switching to the new chat root, so re-entering Settings never resurrects it', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': ChatFooterConnectionLauncher,
          'profiles/[profileId]/(drawer)/settings/index': () => <Text>{routeLabels.settings}</Text>,
          'profiles/[profileId]/(drawer)/settings/privacy': () => (
            <Text>{routeLabels.privacy}</Text>
          ),
          // `settings/connection` is intentionally NOT overridden — the real route file (with
          // its `onSaved` wiring) must be exercised for this regression to be meaningful.
        },
      },
      {
        initialUrl: '/profiles/profile-1/chats/chat-1',
        wrapper: defaultWrapper,
      },
    );

    // The drawer footer's anchored push lands on the modal, same as the sibling test above.
    expect(result.getPathname()).toBe('/profiles/profile-1/settings/connection');
    expect(mockConnectionScreenProps?.['onSaved']).toEqual(expect.any(Function));

    // Simulate a successful Save completing for the profile already active in this Settings
    // instance (edit mode keeps the same profile id).
    act(() =>
      (mockConnectionScreenProps?.['onSaved'] as (nextProfileId: string) => void)('profile-1'),
    );

    // Root navigation switches the Drawer to the newly (re)activated chat root...
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/new');
    // ...and the connection modal must be gone from the tree entirely, not merely unfocused
    // underneath the new root.
    expect(countNamedRoutes(result.getRouterState(), 'connection')).toBe(0);

    // Re-entering Settings (e.g. tapping the drawer's Settings item again) must land cleanly
    // on Settings' own index.
    act(() => navigateRoot(routes.settings('profile-1')));
    expect(result.getPathname()).toBe('/profiles/profile-1/settings');
    expect(screen.getByText(routeLabels.settings)).toBeTruthy();

    // Prove Settings' own nested Stack was actually unwound to a single `index` entry — not
    // `[index, connection, index]`, the vendored StackRouter's duplicate-push symptom — by
    // pushing a real, distinct Settings screen and inspecting the full stack beneath it.
    act(() => router.push(routes.privacy('profile-1')));
    const settingsStack = findStackContaining(result.getRouterState(), 'privacy');
    expect(settingsStack?.routes.map((route) => route.name)).toEqual(['index', 'privacy']);

    // Back must return to Settings' own index, never resurrect the saved connection editor —
    // the exact symptom this fix addresses.
    act(() => router.back());
    expect(result.getPathname()).toBe('/profiles/profile-1/settings');
    expect(screen.getByText(routeLabels.settings)).toBeTruthy();
  });
});
