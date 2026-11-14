import type * as WsModule from '@bridge/ws/ws';
import type * as WsErrorsModule from '@bridge/ws/errors';

// The real chat screen, router, and local transport run; only the desktop bridge is replaced by a
// double that rejects non-bridge thread ids exactly as the Rust bridge does.
jest.mock('@shell/navigation/DrawerContent', () => ({
  DrawerContent: () => {
    const { DrawerProfileRow } = jest.requireActual('@shell/profiles/ProfileSwitcher');
    return DrawerProfileRow({ styles: { row: {}, rowPressed: {}, label: {}, value: {} } });
  },
}));
jest.mock('@shell/boot/AppShells', () => ({ ConnectionScreen: () => null }));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(() => null, { glyphMap: {} }),
}));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../../features/chat/message/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
  ToolInvocationRow: () => null,
}));
jest.mock('../../features/chat/screen/AtomGlyph', () => ({ AtomGlyph: () => null }));

interface MockRemoteCall {
  method: string;
  params: Record<string, unknown> | undefined;
}
const mockRemoteCalls: MockRemoteCall[] = [];
const MOCK_CREATED_THREAD_ID = 'v1.b3BlbmNvZGU.c2VzX2NyZWF0ZWQ';

jest.mock('@bridge/ws/ws', () => {
  const actual = jest.requireActual<typeof WsModule>('@bridge/ws/ws');
  // Mirrors `AgentSessionId::decode` in services/rust-bridge/src/acp/identity.rs.
  const OPAQUE_THREAD_ID = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
  const cwd = '/Users/me/Code';
  let sent: string | null = null;
  const queue = (threadId: unknown) => ({
    threadId,
    items: [],
    pendingSteers: [],
    pendingSteerCount: 0,
    waitingForToolCalls: false,
    steeringInFlight: false,
    lastError: null,
  });
  const thread = () => ({
    id: MOCK_CREATED_THREAD_ID,
    agentId: 'opencode',
    cwd,
    status: sent ? 'running' : 'idle',
    turns: sent
      ? [
          {
            id: 'turn-1',
            status: 'inProgress',
            items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: sent }] }],
          },
        ]
      : [],
  });
  const empty = () => [];
  const page = () => ({ data: [], nextCursor: null });
  const answers: Record<string, (params: MockRemoteCall['params']) => unknown> = {
    'bridge/capabilities/read': () => ({
      protocolVersion: 2,
      streamId: 'stream-1',
      preferredAgentId: 'opencode',
      activeAgentId: 'opencode',
      agents: [
        {
          agentId: 'opencode',
          displayName: 'OpenCode',
          version: '1',
          provenance: 'test',
          lifecycle: 'ready',
        },
      ],
      supportsByAgent: { opencode: {} },
      agUiEvents: true,
      supports: {},
    }),
    'bridge/thread/create': (params) => ({
      submissionId: params?.['submissionId'],
      thread: thread(),
    }),
    'bridge/thread/queue/send': (params) => {
      sent = typeof params?.['content'] === 'string' ? params['content'] : null;
      return {
        submissionId: params?.['submissionId'],
        disposition: 'sent',
        queue: queue(params?.['threadId']),
        turnId: 'turn-1',
      };
    },
    'thread/read': () => ({ thread: thread() }),
    'bridge/thread/queue/read': (params) => queue(params?.['threadId']),
    'bridge/thread/schedules/read': (params) => ({ threadId: params?.['threadId'], schedules: [] }),
    'bridge/approvals/list': empty,
    'bridge/userInput/list': empty,
    'thread/list': page,
    'model/list': page,
  };

  class HostBridgeWsClient extends actual.HostBridgeWsClient {
    private readonly desktop: boolean;

    constructor(...args: ConstructorParameters<typeof actual.HostBridgeWsClient>) {
      super(...args);
      this.desktop = args[0].startsWith('https://');
    }

    override connect(): void {
      if (this.desktop) {
        this.emitStatus(true);
      } else {
        super.connect();
      }
    }

    override disconnect(): void {
      if (!this.desktop) {
        super.disconnect();
      }
    }

    override notify(...args: Parameters<WsModule.HostBridgeWsClient['notify']>): boolean {
      return this.desktop || super.notify(...args);
    }

    override async request<T>(method: string, params?: unknown): Promise<T> {
      if (!this.desktop) {
        return super.request<T>(method, params);
      }
      const record = params as Record<string, unknown> | undefined;
      mockRemoteCalls.push({ method, params: record });
      const threadId = record?.['threadId'];
      if (typeof threadId === 'string' && !OPAQUE_THREAD_ID.test(threadId)) {
        const { RpcRequestError } = jest.requireActual<typeof WsErrorsModule>('@bridge/ws/errors');
        throw new RpcRequestError(method, -32000, 'invalid opaque ACP thread ID');
      }
      return Promise.resolve((answers[method]?.(record) ?? {}) as T);
    }
  }
  return { ...actual, HostBridgeWsClient };
});

// Load the chat screen with the app's Reanimated double before expo-router's testing library
// registers its stock mock, which lacks the easing curves the transcript uses.
import '../../features/chat/screen/MainScreen';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { PropsWithChildren } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { getMessageText } from '@bridge/messages';
import { LocalBridgeServer } from '../../features/on-device/transport/server';
import { FakeAgentPort } from '../../features/on-device/transport/testing';
import { selectedChatAtom } from '../../features/chat/state/session';
import { errorAtom } from '../../features/chat/state/turn';
import { useAppBridgeLifecycle } from '@shell/boot/useAppBridgeLifecycle';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { createDefaultAppStateData } from '@shell/state/appState';
import { activeProfileIdAtom, localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { chatSnapshotCacheAtom } from '@shell/state/chat/atoms';
import { localTransportAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { AppStateProvider } from '@shell/state/store';
import { createTestStore } from '@shell/state/testing';
import { AppThemeProvider, createAppTheme } from '@shared/theme';

function RootLayout() {
  useAppBridgeLifecycle();
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <AppThemeProvider theme={createAppTheme('dark')}>
        <Stack screenOptions={{ headerShown: false }} />
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}

async function renderLocalChat() {
  const port = new FakeAgentPort();
  const created = await port.createThread('ws-one', 'qwen3-1.7b-q4-k-m');
  const local = {
    ...created,
    status: 'complete' as const,
    messages: [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'Local question',
        createdAt: created.createdAt,
      },
    ],
  };
  port.put(local);
  const transport = new LocalBridgeWsClient(new LocalBridgeServer(port));
  transport.connect();

  const data = createDefaultAppStateData();
  data.settings = { ...data.settings, defaultStartCwd: '/Users/me/Code' };
  data.bridgeProfiles = {
    activeProfileId: LOCAL_PROFILE_ID,
    profiles: [
      {
        id: 'desk',
        name: 'Desk',
        bridgeUrl: 'https://desk.test',
        bridgeToken: 'token',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const store = createTestStore({ data });
  store.set(localProfileAvailableAtom, true);
  store.set(localTransportAtom, transport);
  store.set(chatSnapshotCacheAtom, null);
  const Wrapper = ({ children }: PropsWithChildren) => (
    <AppStateProvider store={store}>{children}</AppStateProvider>
  );
  const result = renderRouter(
    { appDir: './src/app', overrides: { _layout: RootLayout } },
    { initialUrl: `/profiles/on-device/chats/${local.id}`, wrapper: Wrapper },
  );
  await waitFor(() => expect(store.get(selectedChatAtom)?.id).toBe(local.id));
  return { store, result, localThreadId: local.id };
}

describe('switching from On this iPhone to a desktop bridge', () => {
  beforeEach(() => {
    mockRemoteCalls.length = 0;
  });

  it('opens a new desktop chat and keeps a sent chat on screen', async () => {
    const { store, result, localThreadId } = await renderLocalChat();
    const namesLocalThread = (call: MockRemoteCall) =>
      JSON.stringify(call.params ?? {}).includes(localThreadId);

    // The drawer's "Runs on" switcher, as the user picked the desktop profile.
    fireEvent.press(screen.getByTestId('drawer-profile-switcher'));
    fireEvent.press(screen.getByLabelText('Desk'));
    await waitFor(() => expect(store.get(activeProfileIdAtom)).toBe('desk'));
    await waitFor(() =>
      expect(mockRemoteCalls.some((call) => call.method === 'bridge/capabilities/read')).toBe(true),
    );

    // The desktop profile opens a new chat; the local chat id never reaches its bridge.
    expect(result.getPathname()).toBe('/profiles/desk/chats/new');
    expect(store.get(selectedChatAtom)).toBeNull();
    expect(store.get(errorAtom)).toBeNull();
    expect(screen.queryByText(/invalid opaque ACP thread ID/u)).toBeNull();
    expect(mockRemoteCalls.filter(namesLocalThread)).toEqual([]);

    fireEvent.changeText(screen.getByLabelText('Message'), 'Hi');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Send message'));
      await Promise.resolve();
    });

    // The created chat is the one on screen, with the sent message, and stays there.
    await waitFor(() =>
      expect(result.getPathname()).toBe(`/profiles/desk/chats/${MOCK_CREATED_THREAD_ID}`),
    );
    await waitFor(() =>
      expect(
        store
          .get(selectedChatAtom)
          ?.messages.filter((message) => message.role === 'user')
          .map(getMessageText),
      ).toEqual(['Hi']),
    );
    expect(store.get(selectedChatAtom)?.id).toBe(MOCK_CREATED_THREAD_ID);
    expect(store.get(errorAtom)).toBeNull();
    expect(screen.getByLabelText('Message').props['value']).toBe('');
    expect(mockRemoteCalls.map((call) => call.method)).toEqual(
      expect.arrayContaining(['bridge/thread/create', 'bridge/thread/queue/send']),
    );
    expect(
      mockRemoteCalls.find((call) => call.method === 'bridge/thread/queue/send')?.params,
    ).toMatchObject({ threadId: MOCK_CREATED_THREAD_ID, content: 'Hi' });
    expect(mockRemoteCalls.filter(namesLocalThread)).toEqual([]);
  });
});
