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
jest.mock('./DrawerContent', () => ({ DrawerContent: () => null }));
jest.mock('react-native-webview', () => ({ WebView: () => null }));

import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import {
  useEffect,
  useState,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { Text } from 'react-native';

import { createDefaultAppStateData } from '../appState';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import { AppStateProvider } from '../state/store';
import { createTestStore } from '../state/testing';
import { navigateRoot, replaceRoot } from './routeNavigation';
import { routes } from './routes';
import { usePromoteNewChatRoute } from './usePromoteNewChatRoute';
import { useProfileRouteReady } from './ProfileRouteBoundary';

const mainLifecycle: string[] = [];
const mainRenders: string[] = [];
let promoteChat: ((chatId: string) => void) | null = null;
let defaultWrapper: ComponentType<PropsWithChildren>;

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

const routeLabels = {
  agent: 'Agent route',
  browser: 'Browser route',
  checkout: 'Checkout route',
  connection: 'Connection route',
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
  const { chatId = 'new', profileId = 'profile-1' } = useLocalSearchParams<{
    chatId?: string;
    profileId?: string;
  }>();
  useEffect(() => {
    router.push(routes.connection(profileId, chatId, 'edit'), { withAnchor: true });
  }, [chatId, profileId]);
  return <Text>Settings launcher</Text>;
}

const baseOverrides = {
  _layout: RootLayout,
};

function countNamedRoutes(state: unknown, routeName: string): number {
  if (!state || typeof state !== 'object') return 0;
  const routesValue = (state as { routes?: unknown }).routes;
  if (!Array.isArray(routesValue)) return 0;
  return routesValue.reduce((count, route) => {
    if (!route || typeof route !== 'object') return count;
    const record = route as { name?: unknown; state?: unknown };
    return count + (record.name === routeName ? 1 : 0) + countNamedRoutes(record.state, routeName);
  }, 0);
}

describe('Expo Router route topology', () => {
  beforeEach(() => {
    mainLifecycle.length = 0;
    mainRenders.length = 0;
    promoteChat = null;
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

  it('anchors the chat index when Settings opens the connection modal', () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          ...baseOverrides,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': MainRoute,
          'profiles/[profileId]/(drawer)/chats/[chatId]/connection': ConnectionRoute,
          'profiles/[profileId]/(drawer)/settings/index': SettingsConnectionLauncher,
        },
      },
      {
        initialUrl: '/profiles/profile-1/settings?chatId=chat-1',
        wrapper: defaultWrapper,
      },
    );

    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1/connection');
    expect(screen.getByText('Connection')).toBeTruthy();
    expect(mainLifecycle).toEqual(['mount']);
    act(() => router.back());
    expect(result.getPathname()).toBe('/profiles/profile-1/chats/chat-1');
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
});
