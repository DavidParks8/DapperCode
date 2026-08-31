import { Stack } from 'expo-router';
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

import { useLocalSearchParams } from 'expo-router';
import { act, renderRouter, screen } from 'expo-router/testing-library';
import { useEffect, type PropsWithChildren, type ReactNode } from 'react';
import { Text } from 'react-native';

import type { Chat } from '@bridge/types/types';
import { createDefaultAppStateData } from '@shell/state/appState';
import { AppStateProvider } from '@shell/state/store';
import { createTestStore } from '@shell/state/testing';
import { useMainScreenChatNavigation } from './chatNavigation';

const chatScreenLifecycle: string[] = [];
const selectedChatIds: string[] = [];
let forkConversation: ((messageId: string) => Promise<unknown>) | null = null;
let navigationContext: ReturnType<typeof createNavigationContext> | null = null;

function chat(id: string): Chat {
  return {
    id,
    title: id,
    status: 'complete',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    statusUpdatedAt: '2026-09-01T00:00:01.000Z',
    lastMessagePreview: 'Answer',
    messages: [
      { id: `${id}-user`, role: 'user', content: 'Ask', createdAt: '2026-09-01T00:00:00.000Z' },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        content: 'Answer',
        createdAt: '2026-09-01T00:00:01.000Z',
      },
    ],
  };
}

function createNavigationContext(source: Chat, forked: Chat) {
  const chatIdRef = { current: source.id };
  return {
    api: {
      forkChat: jest.fn(async () => forked),
      rememberChat: jest.fn(),
      peekChat: jest.fn(() => null),
      peekChatShell: jest.fn(() => null),
    },
    applyThreadRuntimeSnapshot: jest.fn(),
    attachmentController: { closePathModal: jest.fn() },
    autoEnabledPlanTurnIdByThreadRef: { current: {} },
    chatIdRef,
    loadChat: jest.fn(async () => true),
    mergeChatWithPendingOptimisticMessages: (value: Chat) => value,
    openingChatStartedAtRef: { current: 0 },
    refreshPendingApprovalsForThread: jest.fn(async () => undefined),
    selectedChatIdRef: chatIdRef,
    selectedChatRef: { current: source },
    setOpeningChatId: jest.fn(),
    setSelectedChat: jest.fn(),
    setSelectedChatId: (id: string) => {
      chatIdRef.current = id;
      selectedChatIds.push(id);
    },
    setTranscriptContinuationState: jest.fn(),
    stopRequestedRef: { current: false },
    stopSystemMessageLoggedRef: { current: false },
    transcriptContinuationController: { loadEarlier: jest.fn() },
    transcriptContinuationState: { loading: false },
  };
}

function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

/**
 * Stands in for MainScreen: one chat screen per route entry, rendering the chat its own route
 * params name. Two live chat screens with diverging ids is exactly what made the transcript
 * strobe, so the rendered id is the assertion surface.
 */
function ForkableChatRoute() {
  const { chatId = 'missing' } = useLocalSearchParams<{ chatId?: string }>();
  const navigation = useMainScreenChatNavigation(navigationContext as never);
  forkConversation = navigation.forkConversation;
  useEffect(() => {
    chatScreenLifecycle.push('mount');
    return () => {
      chatScreenLifecycle.push('unmount');
    };
  }, []);
  return <Text>Chat {chatId}</Text>;
}

describe('forking a conversation', () => {
  let wrapper: ({ children }: PropsWithChildren) => React.JSX.Element;

  beforeEach(() => {
    chatScreenLifecycle.length = 0;
    selectedChatIds.length = 0;
    forkConversation = null;
    navigationContext = createNavigationContext(chat('source-chat'), chat('forked-chat'));
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
    wrapper = ({ children }: PropsWithChildren) => (
      <AppStateProvider store={store}>{children}</AppStateProvider>
    );
  });

  it('lands on the forked chat without leaving a second chat screen behind', async () => {
    const result = renderRouter(
      {
        appDir: './src/app',
        overrides: {
          _layout: RootLayout,
          'profiles/[profileId]/(drawer)/chats/[chatId]/index': ForkableChatRoute,
        },
      },
      { initialUrl: '/profiles/profile-1/chats/source-chat', wrapper },
    );

    expect(screen.getByText('Chat source-chat')).toBeTruthy();

    await act(async () => {
      await forkConversation?.('source-chat-assistant');
    });

    expect(result.getPathname()).toBe('/profiles/profile-1/chats/forked-chat');
    expect(screen.getByText('Chat forked-chat')).toBeTruthy();
    // A pushed duplicate keeps the source chat mounted underneath, and the two screens then fight
    // over the shared selected-chat state, which is what strobed the transcript before it crashed.
    expect(screen.queryByText('Chat source-chat')).toBeNull();
    expect(countChatRoutes(result.getRouterState())).toBe(1);
    expect(chatScreenLifecycle).toEqual(['mount']);
    expect(selectedChatIds).toEqual(['forked-chat']);
  });
});

function countChatRoutes(state: unknown): number {
  if (!state || typeof state !== 'object') {
    return 0;
  }
  const routesValue = (state as { routes?: unknown }).routes;
  if (!Array.isArray(routesValue)) {
    return 0;
  }
  return routesValue.reduce((count: number, route) => {
    if (!route || typeof route !== 'object') {
      return count;
    }
    const record = route as { name?: unknown; state?: unknown };
    return count + (record.name === 'index' ? 1 : 0) + countChatRoutes(record.state);
  }, 0);
}
