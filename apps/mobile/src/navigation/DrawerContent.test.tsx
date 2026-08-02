import { useMemo } from 'react';
jest.mock('expo-router', () => jest.requireActual('../testing/expoRouterMock'));
import { router } from 'expo-router';
import {
  AccessibilityInfo,
  Alert,
  AppState,
  Keyboard,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../api/client';
import type {
  AgentDescriptor,
  ChatSummary,
  PendingApproval,
  PendingUserInputRequest,
  RpcNotification,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { workspaceChatLimitAtom } from '../state/appState/settings';
import { selectedChatIdAtom } from '../state/chat/atoms';
import { createBridgeTestStore, withAppStore } from '../state/testing';
import type { AppStore } from '../state/types';
import type { WorkspaceChatLimit } from '../appSettings';
import { createEmptyChatSummaryCache, mergeChatSummaryCache } from '../chatSummaryCache';
import * as ChatSummaryCache from '../chatSummaryCache';
import { AppThemeProvider, createAppTheme } from '../theme';
import { DrawerContent } from './DrawerContent';
import { createDrawerContentStyles } from './drawerContentStyles';
import { routes } from './routes';
import { DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS } from './useDrawerChatCollection';

jest.mock('react-native-reanimated', () => jest.requireActual('../testing/reanimatedMock'));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('../testing/gestureHandlerMock'),
);
jest.mock('../chatSummaryCache', () => {
  const actual = jest.requireActual('../chatSummaryCache');
  return {
    ...actual,
    loadChatSummaryCache: jest.fn((profileId: string) =>
      Promise.resolve(actual.createEmptyChatSummaryCache(profileId)),
    ),
    persistChatSummaries: jest.fn().mockResolvedValue(undefined),
    reconcilePersistedChatSummaries: jest.fn().mockResolvedValue(undefined),
    deletePersistedChatSummary: jest.fn().mockResolvedValue(undefined),
  };
});

interface DrawerProbeProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  active?: boolean;
  selectedChatId?: string | null;
  workspaceChatLimit?: WorkspaceChatLimit;
  onClose?: () => void;
  store?: AppStore;
}

export function createDrawerStore(
  api: HostBridgeApiClient,
  ws: HostBridgeWsClient,
  options: { selectedChatId?: string | null; workspaceChatLimit?: WorkspaceChatLimit } = {},
): AppStore {
  const store = createBridgeTestStore({ api, ws });
  store.set(selectedChatIdAtom, options.selectedChatId ?? null);
  if (options.workspaceChatLimit !== undefined) {
    store.set(workspaceChatLimitAtom, options.workspaceChatLimit);
  }
  return store;
}

/** Renders DrawerContent against a hydrated jotai store using the legacy prop shape. */
function DrawerContentProbe({
  api,
  ws,
  active = true,
  selectedChatId = null,
  workspaceChatLimit,
  onClose,
  store,
}: DrawerProbeProps) {
  const fallbackStore = useMemo(
    () => createDrawerStore(api, ws, { selectedChatId, workspaceChatLimit }),
    [api, selectedChatId, workspaceChatLimit, ws],
  );
  return withAppStore(store ?? fallbackStore, <DrawerContent active={active} onClose={onClose} />);
}

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

type Queryable = ReactTestInstance & {
  type: unknown;
  children: unknown[];
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

const theme = createAppTheme('dark');
const listedChat: ChatSummary = {
  id: 'thread',
  title: 'Listed thread',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'done',
  cwd: '/workspace',
};

const readyAgents: AgentDescriptor[] = [
  {
    agentId: 'copilot',
    displayName: 'Copilot',
    version: '1',
    provenance: 'test',
    lifecycle: 'ready',
  },
  {
    agentId: 'codex',
    displayName: 'Codex',
    version: '1',
    provenance: 'test',
    lifecycle: 'ready',
  },
  {
    agentId: 'offline',
    displayName: 'Offline agent',
    version: '1',
    provenance: 'test',
    lifecycle: 'unavailable',
  },
];

interface DrawerHarness {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  emitEvent: (event: RpcNotification) => void;
  emitStatus: (connected: boolean) => void;
  cancelStream: jest.Mock;
}

function createChat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  const id = overrides.id ?? 'thread';
  return {
    ...listedChat,
    id,
    title: overrides.title ?? `Chat ${id}`,
    createdAt: overrides.createdAt ?? '2026-07-20T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: overrides.statusUpdatedAt ?? '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function createApproval(
  threadId: string,
  overrides: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    requestId: `approval-${threadId}`,
    agentId: 'codex',
    kind: 'command',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    title: 'Approval required',
    message: 'Approve this command.',
    requestedAt: '2026-07-20T00:29:30.000Z',
    options: [{ id: 'accept', label: 'Accept' }],
    ...overrides,
  };
}

function createUserInput(
  threadId: string,
  overrides: Partial<PendingUserInputRequest> = {},
): PendingUserInputRequest {
  return {
    requestId: `input-${threadId}`,
    agentId: 'copilot',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    message: 'Input required.',
    requestedAt: '2026-07-20T00:29:00.000Z',
    questions: [],
    ...overrides,
  };
}

function createHarness({
  chats = [],
  agents = readyAgents,
  approvals = [],
  userInputs = [],
  connected = true,
  streamFailure = false,
  listFailure = false,
  approvalFailure = false,
  userInputFailure = false,
}: {
  chats?: ChatSummary[];
  agents?: AgentDescriptor[];
  approvals?: PendingApproval[];
  userInputs?: PendingUserInputRequest[];
  connected?: boolean;
  streamFailure?: boolean;
  listFailure?: boolean;
  approvalFailure?: boolean;
  userInputFailure?: boolean;
} = {}): DrawerHarness {
  const eventHandlers = new Set<(event: RpcNotification) => void>();
  const statusHandlers = new Set<(connected: boolean) => void>();
  const cancelStream = jest.fn();
  const listChats = listFailure
    ? jest.fn().mockRejectedValue(new Error('list failed'))
    : jest.fn().mockResolvedValue(chats);
  const api = {
    profileId: 'profile-1',
    readBridgeCapabilities: jest.fn().mockResolvedValue({ agents, supportsByAgent: {} }),
    deleteChat: jest.fn().mockResolvedValue(undefined),
    forgetChat: jest.fn(),
    peekAllChats: jest.fn().mockReturnValue(null),
    peekChats: jest.fn().mockReturnValue(null),
    rememberChats: jest.fn(),
    listLoadedChatIds: jest.fn().mockResolvedValue([]),
    getChatSummaries: jest.fn().mockResolvedValue([]),
    listApprovals: approvalFailure
      ? jest.fn().mockRejectedValue(new Error('approval list failed'))
      : jest.fn().mockResolvedValue(approvals),
    listPendingUserInputs: userInputFailure
      ? jest.fn().mockRejectedValue(new Error('user input list failed'))
      : jest.fn().mockResolvedValue(userInputs),
    listChats,
    listAllChats: jest.fn().mockResolvedValue({ chats, partial: false, diagnostics: [] }),
    startChatListStream: streamFailure
      ? jest.fn().mockRejectedValue(new Error('stream failed'))
      : jest.fn().mockImplementation(async (_options, onBatch) => {
          onBatch({ streamId: 'stream', limit: 20, done: true, chats });
          return { streamId: 'stream', cancel: cancelStream };
        }),
  } as unknown as HostBridgeApiClient;
  const ws = {
    isConnected: connected,
    onEvent: jest.fn().mockImplementation((handler) => {
      eventHandlers.add(handler);
      return jest.fn(() => eventHandlers.delete(handler));
    }),
    onStatus: jest.fn().mockImplementation((handler) => {
      statusHandlers.add(handler);
      return jest.fn(() => statusHandlers.delete(handler));
    }),
  } as unknown as HostBridgeWsClient;

  return {
    api,
    ws,
    emitEvent: (event) => eventHandlers.forEach((handler) => handler(event)),
    emitStatus: (nextConnected) => statusHandlers.forEach((handler) => handler(nextConnected)),
    cancelStream,
  };
}

async function renderDrawer(
  harness: DrawerHarness,
  props: Partial<DrawerProbeProps> = {},
): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <DrawerContentProbe
            api={harness.api}
            ws={harness.ws}
            active
            selectedChatId={null}
            {...props}
          />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
  if (!tree) throw new Error('Expected drawer tree');
  return tree;
}

function findByLabel(root: Queryable, label: string): Queryable {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Expected accessibility label: ${label}`);
  return node;
}

async function press(node: Queryable, prop = 'onPress'): Promise<void> {
  const handler = node.props[prop];
  if (typeof handler !== 'function') throw new Error(`Expected ${prop} handler`);
  await act(async () => {
    (handler as () => void)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function hasText(root: Queryable, value: string): boolean {
  return root.findAll((node) => textContent(node).includes(value)).length > 0;
}

function textContent(node: Queryable): string {
  return node.children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : textContent(child as Queryable),
    )
    .join('');
}

function renderPressedStyles(root: Queryable): void {
  for (const node of root.findAll((candidate) => typeof candidate.props.style === 'function')) {
    (node.props.style as (state: { pressed: boolean }) => unknown)({ pressed: true });
  }
}

async function exercisePressResponders(root: Queryable): Promise<void> {
  const responders = root.findAll((node) => typeof node.props.onResponderGrant === 'function');
  await act(async () => {
    for (const node of responders) {
      const event = { nativeEvent: {}, persist: jest.fn() };
      (node.props.onResponderGrant as (event: unknown) => void)(event);
      if (typeof node.props.onResponderRelease === 'function') {
        (node.props.onResponderRelease as (event: unknown) => void)(event);
      }
    }
    await Promise.resolve();
  });
}

describe('DrawerContent render behavior matrix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-20T00:30:00.000Z'));
    (ChatSummaryCache.loadChatSummaryCache as jest.Mock).mockImplementation((profileId: string) =>
      Promise.resolve(createEmptyChatSummaryCache(profileId)),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders loading, then the empty state when boundary loading fails', async () => {
    let rejectStream: ((error: Error) => void) | undefined;
    const harness = createHarness({ streamFailure: true, listFailure: true });
    (harness.api.startChatListStream as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStream = reject;
        }),
    );

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe api={harness.api} ws={harness.ws} active selectedChatId={null} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      await Promise.resolve();
    });
    if (!tree) throw new Error('Expected drawer tree');
    expect(hasText(tree.root as Queryable, 'Loading sessions')).toBe(true);

    await act(async () => {
      rejectStream?.(new Error('stream failed'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'No sessions yet')).toBe(true);
    expect(
      hasText(
        tree.root as Queryable,
        'Start a new chat and it will appear here with live activity.',
      ),
    ).toBe(true);
    act(() => tree?.unmount());
  });

  it('keeps pending-session hydration failures retryable in an empty drawer', async () => {
    const harness = createHarness({
      connected: false,
      userInputs: [createUserInput('missing-child')],
    });
    (harness.api.getChatSummaries as jest.Mock).mockRejectedValue(new Error('summary unavailable'));
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const noticeLabel = 'Some pending request sessions could not be loaded. Retry';

    expect(findByLabel(root, noticeLabel)).toBeDefined();
    expect(root.findAll((node) => node.type === RefreshControl)).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findByLabel(root, noticeLabel)).toBeDefined();

    await act(async () => {
      harness.emitStatus(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(root.findAll((node) => node.props.accessibilityLabel === noticeLabel)).toHaveLength(0);

    await act(async () => {
      harness.emitStatus(false);
      await Promise.resolve();
    });
    expect(findByLabel(root, noticeLabel)).toBeDefined();

    act(() => tree.unmount());
  });

  it('clears a hydration warning when the live stream supplies the pending session', async () => {
    let streamBatch:
      | ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void)
      | undefined;
    const hydrated = createChat({
      id: 'stream-child',
      title: 'Streamed pending session',
      cwd: '/repo/streamed',
      agentId: 'codex',
    });
    const harness = createHarness({
      connected: false,
      userInputs: [createUserInput('stream-child')],
    });
    (harness.api.getChatSummaries as jest.Mock).mockRejectedValue(new Error('summary unavailable'));
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      onBatch({ streamId: 'stream', limit: 5, done: false, chats: [] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const noticeLabel = 'Some pending request sessions could not be loaded. Retry';
    expect(findByLabel(root, noticeLabel)).toBeDefined();

    await act(async () => {
      streamBatch?.({
        streamId: 'stream',
        limit: 5,
        done: false,
        chats: [hydrated],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(root.findAll((node) => node.props.accessibilityLabel === noticeLabel)).toHaveLength(0);
    expect(
      findByLabel(root, 'Streamed pending session, streamed, Codex, Input requested'),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('renders the close control only when the drawer can be dismissed', async () => {
    const onClose = jest.fn();
    const harness = createHarness({ chats: [createChat({ id: 'root' })] });
    const withoutClose = await renderDrawer(harness);
    expect(
      (withoutClose.root as Queryable).findAll(
        (candidate) => candidate.props.accessibilityLabel === 'Close session list',
      ),
    ).toHaveLength(0);
    act(() => withoutClose.unmount());

    const tree = await renderDrawer(harness, { onClose });
    await press(findByLabel(tree.root as Queryable, 'Close session list'));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('renders attention lanes, explicit agents, selection, and primary actions', async () => {
    const chats = [
      createChat({
        id: 'root',
        title: 'Running root',
        status: 'running',
        cwd: '/repo/alpha',
        agentId: 'copilot',
        updatedAt: '2026-07-20T00:29:00.000Z',
      }),
      createChat({
        id: 'approval',
        title: 'Approval chat',
        cwd: '/repo/beta',
        agentId: 'codex',
        updatedAt: '2026-07-20T00:28:00.000Z',
      }),
      createChat({
        id: 'input',
        title: 'Input chat',
        cwd: '/repo/beta',
        agentId: 'copilot',
        updatedAt: '2026-07-20T00:27:30.000Z',
      }),
      createChat({
        id: 'failed',
        title: 'Failed chat',
        status: 'error',
        cwd: '/repo/beta',
        agentId: 'codex',
        lastError: 'Build failed',
        updatedAt: '2026-07-20T00:27:00.000Z',
      }),
      createChat({
        id: 'recent',
        title: 'Recent chat',
        cwd: '/repo/alpha',
        agentId: 'copilot',
        updatedAt: '2026-07-20T00:26:00.000Z',
      }),
    ];
    const harness = createHarness({
      chats,
      approvals: [createApproval('approval')],
      userInputs: [createUserInput('input')],
    });
    const store = createDrawerStore(harness.api, harness.ws, { selectedChatId: 'root' });
    const tree = await renderDrawer(harness, { selectedChatId: 'root', store });
    const root = tree.root as Queryable;

    expect(findByLabel(root, 'Needs your attention, 3 sessions').props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: true }),
    );
    expect(
      findByLabel(root, 'Running root, alpha, Copilot, Working').props.accessibilityState,
    ).toEqual(expect.objectContaining({ selected: true }));
    expect(findByLabel(root, 'Approval chat, beta, Codex, Approval requested')).toBeDefined();
    expect(findByLabel(root, 'Input chat, beta, Copilot, Input requested')).toBeDefined();
    expect(findByLabel(root, 'Failed chat, beta, Codex, Failed')).toBeDefined();
    expect(hasText(root, 'Copilot')).toBe(true);
    expect(hasText(root, 'Codex')).toBe(true);

    await press(findByLabel(root, 'Running root, alpha, Copilot, Working'));
    await press(findByLabel(root, 'New chat'));
    await press(findByLabel(root, 'Open preview browser'));
    await press(findByLabel(root, 'Open settings'));
    await press(findByLabel(root, 'Needs your attention, 3 sessions'));

    expect(router.navigate).toHaveBeenCalledWith(routes.settings('profile-1'));
    expect(store.get(selectedChatIdAtom)).toBeNull();
    expect(hasText(root, 'Approval chat')).toBe(false);
    act(() => tree.unmount());
  });

  it('filters every lane with the shared folder picker', async () => {
    const harness = createHarness({
      chats: [
        createChat({
          id: 'alpha',
          title: 'Alpha session',
          agentId: 'copilot',
          cwd: '/repo/alpha',
          updatedAt: '2026-07-20T00:29:00.000Z',
        }),
        createChat({
          id: 'beta',
          title: 'Beta session',
          agentId: 'codex',
          cwd: '/repo/beta',
          status: 'running',
          updatedAt: '2026-07-20T00:28:00.000Z',
        }),
      ],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Filter sessions by folder, All folders'));
    await press(findByLabel(root, 'beta'));
    expect(hasText(root, 'Alpha session')).toBe(false);
    expect(hasText(root, 'Beta session')).toBe(true);
    expect(findByLabel(root, 'Filter sessions by folder, beta')).toBeDefined();

    await press(findByLabel(root, 'Filter sessions by folder, beta'));
    await press(findByLabel(root, 'All folders'));
    expect(hasText(root, 'Alpha session')).toBe(true);
    expect(hasText(root, 'Beta session')).toBe(true);
    act(() => tree.unmount());
  });

  it('reacts to websocket connectivity, lifecycle events, and snapshot refresh', async () => {
    const harness = createHarness({
      connected: false,
      chats: [
        createChat({ id: 'live', title: 'Realtime chat', status: 'complete', cwd: '/repo/live' }),
      ],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    expect(hasText(root, 'Bridge offline')).toBe(true);

    await act(async () => {
      harness.emitStatus(true);
      harness.emitEvent({
        method: 'thread/status/changed',
        params: { threadId: 'live', status: 'running' },
      });
      jest.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(root, 'Bridge connected')).toBe(true);
    expect(findByLabel(root, 'Working now, 1 session')).toBeDefined();

    await act(async () => {
      harness.emitEvent({ method: 'bridge/events/snapshotRequired', params: null });
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(3);
    act(() => tree.unmount());
  });

  it('refreshes pending interaction lanes from websocket request events', async () => {
    const pendingChat = createChat({
      id: 'pending',
      title: 'Pending interaction',
      cwd: '/repo/pending',
      agentId: 'copilot',
    });
    const harness = createHarness({ chats: [pendingChat] });
    (harness.api.listApprovals as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createApproval('pending')])
      .mockResolvedValueOnce([]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'pending' } });
      // Event-triggered attention refreshes are debounced to coalesce bursts; advance past the
      // debounce window so the resulting refresh has a chance to land.
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      findByLabel(root, 'Pending interaction, pending, Copilot, Approval requested'),
    ).toBeDefined();

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.resolved', params: { threadId: 'pending' } });
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findByLabel(root, 'Pending interaction, pending, Copilot, Complete')).toBeDefined();
    act(() => tree.unmount());
  });

  it('hydrates a pending sub-agent and requests sub-agent-inclusive chat lists', async () => {
    const rootChat = createChat({
      id: 'parent',
      title: 'Parent session',
      cwd: '/repo/mobile',
      agentId: 'copilot',
    });
    const childChat = createChat({
      id: 'child',
      title: 'Sub-agent request',
      cwd: undefined,
      parentThreadId: 'parent',
      subAgentDepth: 1,
      agentId: 'codex',
    });
    const harness = createHarness({
      chats: [rootChat],
      userInputs: [createUserInput('child')],
    });
    (harness.api.getChatSummaries as jest.Mock).mockResolvedValue([childChat]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(harness.api.getChatSummaries).toHaveBeenCalledWith(['child']);
    expect(harness.api.startChatListStream).toHaveBeenCalledWith(
      expect.objectContaining({ includeSubAgents: true }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(findByLabel(root, 'Sub-agent request, mobile, Codex, Input requested')).toBeDefined();
    act(() => tree.unmount());
  });

  it('keeps successful approval data when user-input refresh fails', async () => {
    const approvalChat = createChat({
      id: 'approval-partial',
      title: 'Visible approval',
      cwd: '/repo/partial',
      agentId: 'codex',
    });
    const harness = createHarness({
      chats: [approvalChat],
      approvals: [createApproval('approval-partial')],
      connected: false,
      userInputFailure: true,
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(findByLabel(root, 'Visible approval, partial, Codex, Approval requested')).toBeDefined();
    expect(findByLabel(root, 'Could not refresh pending input requests. Retry')).toBeDefined();
    act(() => tree.unmount());
  });

  it('retries agent metadata from the drawer notice', async () => {
    const customAgent: AgentDescriptor = {
      agentId: 'custom-agent',
      displayName: 'Friendly Agent',
      version: '1',
      provenance: 'test',
      lifecycle: 'ready',
    };
    const harness = createHarness({
      agents: [customAgent],
      chats: [
        createChat({
          id: 'custom',
          title: 'Custom agent session',
          cwd: '/repo/custom',
          agentId: 'custom-agent',
        }),
      ],
      connected: false,
    });
    (harness.api.readBridgeCapabilities as jest.Mock).mockRejectedValueOnce(
      new Error('capabilities failed'),
    );
    const store = createBridgeTestStore({ api: harness.api, ws: harness.ws });
    const tree = await renderDrawer(harness, { store });
    const root = tree.root as Queryable;

    expect(findByLabel(root, 'Custom agent session, custom, Custom Agent, Complete')).toBeDefined();
    await press(findByLabel(root, 'Could not refresh agent names. Retry'));
    expect(
      findByLabel(root, 'Custom agent session, custom, Friendly Agent, Complete'),
    ).toBeDefined();
    expect(
      root.findAll(
        (node) => node.props.accessibilityLabel === 'Could not refresh agent names. Retry',
      ),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('handles refresh, non-refresh events, app activation, inactivity, and stream cancellation', async () => {
    let appStateHandler: ((state: string) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove };
    });
    const harness = createHarness({
      chats: [createChat({ status: 'running', cwd: '/repo/live' })],
    });
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      onBatch({
        streamId: 'stream',
        limit: 5,
        done: false,
        chats: [createChat({ status: 'running', cwd: '/repo/live' })],
      });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const refreshControl = root.findAll((node) => node.type === RefreshControl)[0];
    if (typeof refreshControl?.props.onRefresh !== 'function')
      throw new Error('Expected refresh control');

    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      harness.emitEvent({ method: 'unrelated/event', params: null });
      harness.emitEvent({ method: 'thread/started', params: { threadId: 'thread' } });
      harness.emitEvent({ method: 'thread/name/updated', params: { threadId: 'thread' } });
      harness.emitStatus(false);
      appStateHandler?.('background');
      appStateHandler?.('active');
      jest.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe
              api={harness.api}
              ws={harness.ws}
              active={false}
              selectedChatId={null}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      harness.emitEvent({
        method: 'thread/status/changed',
        params: { threadId: 'thread', status: 'complete' },
      });
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(harness.cancelStream).toHaveBeenCalled();
    act(() => tree.unmount());
    expect(remove).toHaveBeenCalled();
  });

  it('hydrates cached deep chats and refreshes their newest rows without streaming', async () => {
    const cached = createChat({ id: 'cached', title: 'Cached history', cwd: '/repo/cache' });
    const newest = createChat({
      id: 'newest',
      title: 'Newest refresh',
      cwd: '/repo/cache',
      updatedAt: '2026-07-20T00:29:00.000Z',
    });
    const harness = createHarness();
    (harness.api.peekAllChats as jest.Mock).mockReturnValue([cached]);
    (harness.api.listChats as jest.Mock).mockResolvedValue([newest]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(hasText(root, 'Cached history')).toBe(true);
    expect(hasText(root, 'Newest refresh')).toBe(true);
    expect(harness.api.startChatListStream).not.toHaveBeenCalled();
    expect(harness.api.rememberChats).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('hydrates persisted summaries on a cold offline drawer and retains them on refresh failure', async () => {
    const cached = mergeChatSummaryCache(
      createEmptyChatSummaryCache('profile-1'),
      [createChat({ id: 'offline', title: 'Available offline', cwd: '/repo/cache' })],
      '2026-07-19T00:00:00.000Z',
    );
    const read = ChatSummaryCache.loadChatSummaryCache as jest.Mock;
    read.mockResolvedValue(cached);
    const harness = createHarness({ listFailure: true, streamFailure: true });
    const store = createDrawerStore(harness.api, harness.ws);
    const tree = await renderDrawer(harness, { store });

    expect(read).toHaveBeenCalled();
    expect(hasText(tree.root as Queryable, 'Available offline')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Loading sessions')).toBe(false);
    expect(harness.api.listChats).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('retains stale summaries for a limited streamed refresh', async () => {
    const stale = createChat({ id: 'stale', title: 'Stale retained', cwd: '/repo/cache' });
    const fresh = createChat({
      id: 'fresh',
      title: 'Fresh streamed',
      cwd: '/repo/cache',
      updatedAt: '2026-07-20T00:29:00.000Z',
    });
    const cached = mergeChatSummaryCache(
      createEmptyChatSummaryCache('profile-1'),
      [stale],
      '2026-07-19T00:00:00.000Z',
    );
    (ChatSummaryCache.loadChatSummaryCache as jest.Mock).mockResolvedValue(cached);
    const persist = ChatSummaryCache.persistChatSummaries as jest.Mock;
    const harness = createHarness({ chats: [fresh] });
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      onBatch({ streamId: 'stream', limit: 1, done: true, chats: [fresh] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);

    await act(async () => {
      jest.advanceTimersByTime(DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(hasText(tree.root as Queryable, 'Stale retained')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Fresh streamed')).toBe(true);
    expect(persist).toHaveBeenCalledWith(
      'profile-1',
      expect.arrayContaining([fresh]),
      undefined,
      expect.any(Number),
    );
    act(() => tree.unmount());
  });

  it('coalesces rapid list batches into one persisted summary update', async () => {
    const batches = [
      createChat({ id: 'batch-a', title: 'Batch A' }),
      createChat({ id: 'batch-b', title: 'Batch B' }),
      createChat({ id: 'batch-c', title: 'Batch C' }),
    ];
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      for (const [index, chat] of batches.entries()) {
        onBatch({
          streamId: 'stream',
          limit: index + 1,
          done: false,
          chats: [chat],
        });
      }
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const persist = ChatSummaryCache.persistChatSummaries as jest.Mock;
    const tree = await renderDrawer(harness);

    expect(persist).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(DRAWER_CHAT_SUMMARY_PERSIST_DEBOUNCE_MS - 1);
      await Promise.resolve();
    });
    expect(persist).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      'profile-1',
      expect.arrayContaining(batches.map((chat) => expect.objectContaining({ id: chat.id }))),
      undefined,
      expect.any(Number),
    );
    act(() => tree.unmount());
  });

  it('prunes offline summaries after an authoritative completed stream', async () => {
    const stale = createChat({ id: 'deleted-on-host', title: 'Deleted on host' });
    const current = createChat({
      id: 'current',
      title: 'Current session',
      updatedAt: '2026-07-20T00:29:00.000Z',
    });
    (ChatSummaryCache.loadChatSummaryCache as jest.Mock).mockResolvedValue(
      mergeChatSummaryCache(
        createEmptyChatSummaryCache('profile-1'),
        [stale],
        '2026-07-19T00:00:00.000Z',
      ),
    );
    const reconcile = ChatSummaryCache.reconcilePersistedChatSummaries as jest.Mock;
    const tree = await renderDrawer(createHarness({ chats: [current] }));

    expect(hasText(tree.root as Queryable, 'Deleted on host')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Current session')).toBe(true);
    expect(reconcile).toHaveBeenCalledWith('profile-1', [current]);
    act(() => tree.unmount());
  });

  it('prunes offline summaries after a complete non-partial deep listing', async () => {
    const stale = createChat({ id: 'deep-deleted', title: 'Deep deleted on host' });
    const current = createChat({ id: 'deep-current', title: 'Deep current session' });
    (ChatSummaryCache.loadChatSummaryCache as jest.Mock).mockResolvedValue(
      mergeChatSummaryCache(createEmptyChatSummaryCache('profile-1'), [stale]),
    );
    const harness = createHarness({ chats: [current] });
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      onBatch({ streamId: 'stream', limit: 1, done: true, chats: [current] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    (harness.api.listAllChats as jest.Mock).mockResolvedValue({
      chats: [current],
      partial: false,
      diagnostics: [],
    });
    const reconcile = ChatSummaryCache.reconcilePersistedChatSummaries as jest.Mock;
    const tree = await renderDrawer(harness);
    expect(hasText(tree.root as Queryable, 'Deep deleted on host')).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasText(tree.root as Queryable, 'Deep deleted on host')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Deep current session')).toBe(true);
    expect(reconcile).toHaveBeenCalledWith('profile-1', [current]);
    act(() => tree.unmount());
  });

  it.each([
    ['full', 20],
    ['fast', 5],
  ])('hydrates the %s cached stream tier before live batches', async (_name, cachedLimit) => {
    const harness = createHarness({
      chats: [createChat({ id: 'live-tier', title: 'Live tier', cwd: '/repo/tier' })],
    });
    (harness.api.peekChats as jest.Mock).mockImplementation(({ limit }: { limit: number }) =>
      limit === cachedLimit
        ? [
            createChat({
              id: `cached-${cachedLimit}`,
              title: `Cached ${cachedLimit}`,
              cwd: '/repo/tier',
            }),
          ]
        : null,
    );
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      const chats = [createChat({ id: 'live-tier', title: 'Live tier', cwd: '/repo/tier' })];
      onBatch({ streamId: 'stream', limit: chats.length, done: true, chats });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(hasText(root, `Cached ${cachedLimit}`)).toBe(true);
    expect(hasText(root, 'Live tier')).toBe(true);
    act(() => tree.unmount());
  });

  it('falls back from stream failure through fast and full chat listings', async () => {
    const fast = createChat({ id: 'fast-fallback', title: 'Fast fallback', cwd: '/repo/fallback' });
    const full = createChat({ id: 'full-fallback', title: 'Full fallback', cwd: '/repo/fallback' });
    const harness = createHarness({ streamFailure: true });
    (harness.api.listChats as jest.Mock)
      .mockResolvedValueOnce([fast])
      .mockResolvedValueOnce([fast, full]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(hasText(root, 'Fast fallback')).toBe(true);
    expect(hasText(root, 'Full fallback')).toBe(true);
    expect(harness.api.listChats).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 5 }));
    expect(harness.api.listChats).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 20 }),
    );
    act(() => tree.unmount());
  });

  it('renders deep-page progress and merges loaded chat summaries before completion', async () => {
    let resolveDeep:
      | ((value: { chats: ChatSummary[]; partial: boolean; diagnostics: string[] }) => void)
      | undefined;
    const firstPage = createChat({ id: 'page', title: 'Deep page', cwd: '/repo/deep' });
    const loaded = createChat({ id: 'loaded', title: 'Loaded summary', cwd: '/repo/deep' });
    const harness = createHarness({
      chats: [createChat({ id: 'recent', title: 'Recent row', cwd: '/repo/deep' })],
    });
    (harness.api.listLoadedChatIds as jest.Mock).mockResolvedValue(['recent', 'loaded']);
    (harness.api.getChatSummaries as jest.Mock).mockResolvedValue([loaded]);
    (harness.api.listAllChats as jest.Mock).mockImplementation(({ onPage }) => {
      onPage([firstPage]);
      return new Promise((resolve) => {
        resolveDeep = resolve;
      });
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
    });
    expect(hasText(root, 'Deep page')).toBe(true);
    expect(
      root.findAll((node) => Boolean(node.props.style) && textContent(node) === ''),
    ).not.toHaveLength(0);

    await act(async () => {
      resolveDeep?.({ chats: [firstPage], partial: false, diagnostics: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(root, 'Loaded summary')).toBe(true);
    expect(harness.api.getChatSummaries).toHaveBeenCalledWith(['loaded']);
    act(() => tree.unmount());
  });

  it('shows primed sessions instead of a loading placeholder while hidden', async () => {
    const harness = createHarness();
    const tree = await renderDrawer(harness, { active: false });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasText(tree.root as Queryable, 'Loading sessions')).toBe(false);
    act(() => tree.unmount());
  });

  it('primes while inactive and ignores late capability and stream callbacks after unmount', async () => {
    let resolveCapabilities:
      | ((value: { agents: AgentDescriptor[]; supportsByAgent: Record<string, unknown> }) => void)
      | undefined;
    let streamBatch:
      | ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void)
      | undefined;
    const harness = createHarness();
    (harness.api.readBridgeCapabilities as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveCapabilities = resolve;
      }),
    );
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness, { active: false });

    expect(harness.api.listChats).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    await act(async () => {
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe api={harness.api} ws={harness.ws} active selectedChatId={null} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      await Promise.resolve();
    });
    act(() => tree.unmount());
    await act(async () => {
      resolveCapabilities?.({ agents: readyAgents, supportsByAgent: {} });
      streamBatch?.({ streamId: 'stream', limit: 5, done: true, chats: [listedChat] });
      await Promise.resolve();
    });
    expect(harness.cancelStream).toHaveBeenCalled();
  });

  it('cancels a stream controller that resolves after the drawer deactivates', async () => {
    let resolveStream: ((controller: { streamId: string; cancel: () => void }) => void) | undefined;
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStream = resolve;
          }),
      )
      .mockImplementationOnce(async (_options, onBatch) => {
        onBatch({ streamId: 'second', limit: 5, done: true, chats: [] });
        return { streamId: 'second', cancel: jest.fn() };
      });
    const tree = await renderDrawer(harness);

    await act(async () => {
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe
              api={harness.api}
              ws={harness.ws}
              active={false}
              selectedChatId={null}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      resolveStream?.({ streamId: 'late', cancel: harness.cancelStream });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.cancelStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe api={harness.api} ws={harness.ws} active selectedChatId={null} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('renders light theme, compact counts, duplicate updates, and explicit error state', async () => {
    const manyChats = Array.from({ length: 1001 }, (_, index) =>
      createChat({
        id: `bulk-${index}`,
        title: `Bulk ${index}`,
        cwd: '/repo/bulk',
        updatedAt: `2026-07-19T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      }),
    );
    const olderDuplicate = createChat({
      id: 'duplicate',
      title: 'Older duplicate',
      cwd: '/repo/bulk',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const newerDuplicate = createChat({
      id: 'duplicate',
      title: 'Newer duplicate',
      cwd: '/repo/bulk',
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    const subAgent = createChat({
      id: 'sub-error',
      title: 'Error child',
      cwd: '/repo/bulk',
      subAgentDepth: 2,
      status: 'error',
      lastError: 'Visible failure',
      agentId: 'codex',
    });
    const harness = createHarness({
      chats: [...manyChats, olderDuplicate, newerDuplicate, subAgent],
    });
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={createAppTheme('light')}>
            <DrawerContentProbe
              api={harness.api}
              ws={harness.ws}
              active
              workspaceChatLimit={null}
              selectedChatId="sub-error"
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    if (!tree) throw new Error('Expected light drawer tree');
    const root = tree.root as Queryable;
    expect(hasText(root, '1k')).toBe(true);
    expect(hasText(root, 'Newer duplicate')).toBe(true);
    expect(hasText(root, 'Older duplicate')).toBe(false);
    const errorRow = findByLabel(root, 'Error child, bulk, Codex, Failed');
    expect(errorRow.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    renderPressedStyles(root);
    act(() => tree?.unmount());
  });

  it('queues forced refreshes while a stream starts and settles them after completion', async () => {
    let resolveStream: ((value: { streamId: string; cancel: () => void }) => void) | undefined;
    let streamBatch:
      | ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void)
      | undefined;
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation((_options, onBatch) => {
      streamBatch = onBatch;
      return new Promise((resolve) => {
        resolveStream = resolve;
      });
    });
    const tree = await renderDrawer(harness);

    await act(async () => {
      harness.emitEvent({ method: 'thread/started', params: { threadId: 'queued' } });
      harness.emitEvent({ method: 'bridge/events/snapshotRequired', params: null });
      harness.emitStatus(true);
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    await act(async () => {
      streamBatch?.({
        streamId: 'stream',
        limit: 5,
        done: false,
        chats: [createChat({ id: 'queued', title: 'Queued row' })],
      });
      resolveStream?.({ streamId: 'stream', cancel: harness.cancelStream });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(1);
    expect(hasText(tree.root as Queryable, 'Queued row')).toBe(true);
    act(() => tree.unmount());
  });

  it('keeps collapsed lanes stable as streamed activity changes', async () => {
    let streamBatch:
      | ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void)
      | undefined;
    const first = createChat({ id: 'first', title: 'First recent', cwd: '/repo/first' });
    const second = createChat({ id: 'second', title: 'Second recent', cwd: '/repo/second' });
    const third = createChat({
      id: 'third',
      title: 'New working session',
      cwd: '/repo/third',
      status: 'running',
    });
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      onBatch({ streamId: 'stream', limit: 5, done: false, chats: [first, second] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Recent, 2 sessions'));

    await act(async () => {
      streamBatch?.({ streamId: 'stream', limit: 20, done: false, chats: [first, second, third] });
      await Promise.resolve();
    });
    expect(findByLabel(root, 'Recent, 2 sessions').props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: false }),
    );
    expect(findByLabel(root, 'Working now, 1 session').props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: true }),
    );
    expect(hasText(root, 'First recent')).toBe(false);
    expect(hasText(root, 'New working session')).toBe(true);
    act(() => tree.unmount());
  });

  it('renders pressed responder states for header, folders, lanes, chats, and footer actions', async () => {
    const harness = createHarness({
      chats: Array.from({ length: 4 }, (_, index) =>
        createChat({
          id: `pressed-${index}`,
          title: `Pressed ${index}`,
          cwd: '/repo/pressed',
          status: index === 1 ? 'error' : 'complete',
          lastError: index === 1 ? 'Pressed error' : undefined,
        }),
      ),
    });
    const tree = await renderDrawer(harness, { selectedChatId: 'pressed-1' });
    const root = tree.root as Queryable;
    await exercisePressResponders(root);
    renderPressedStyles(root);
    act(() => tree.unmount());
  });

  it('keeps the newest duplicate and renders rows in attention order', async () => {
    const newest = createChat({
      id: 'duplicate-order',
      title: 'Newest duplicate order',
      cwd: '/repo/a',
      updatedAt: '2026-07-20T00:20:00.000Z',
    });
    const older = createChat({
      id: 'duplicate-order',
      title: 'Older duplicate order',
      cwd: '/repo/a',
      updatedAt: '2026-07-19T00:20:00.000Z',
    });
    const harness = createHarness({
      chats: [
        createChat({
          id: 'plain',
          title: 'Plain root',
          cwd: '/repo/a',
          updatedAt: '2026-07-20T00:29:00.000Z',
        }),
        createChat({
          id: 'working',
          title: 'Working root',
          cwd: '/repo/a',
          status: 'running',
          updatedAt: '2026-07-20T00:27:00.000Z',
        }),
        createChat({ id: 'failed', title: 'Failed root', cwd: '/repo/z', status: 'error' }),
        newest,
        older,
      ],
    });
    const tree = await renderDrawer(harness, { workspaceChatLimit: null });
    const root = tree.root as Queryable;
    expect(hasText(root, 'Newest duplicate order')).toBe(true);
    expect(hasText(root, 'Older duplicate order')).toBe(false);
    expect(findByLabel(root, 'Needs your attention, 1 session')).toBeDefined();
    expect(findByLabel(root, 'Working now, 1 session')).toBeDefined();
    expect(findByLabel(root, 'Recent, 2 sessions')).toBeDefined();
    act(() => tree.unmount());
  });

  it('formats five-digit chat totals as a whole compact count', async () => {
    const chats = Array.from({ length: 10_001 }, (_, index) =>
      createChat({
        id: `count-${index}`,
        title: `Count ${index}`,
        cwd: '/repo/count',
      }),
    );
    const harness = createHarness({ chats });
    const tree = await renderDrawer(harness, { workspaceChatLimit: 10 });
    expect(hasText(tree.root as Queryable, '10k')).toBe(true);
    act(() => tree.unmount());
  });

  it('refreshes cached deep history with the full recent-chat tier', async () => {
    const cached = createChat({
      id: 'deep-cache',
      title: 'Deep cache refresh',
      cwd: '/repo/deep-cache',
    });
    const refreshed = createChat({
      id: 'deep-new',
      title: 'Deep cache newest',
      cwd: '/repo/deep-cache',
    });
    const harness = createHarness();
    (harness.api.peekAllChats as jest.Mock).mockReturnValue([cached]);
    (harness.api.listChats as jest.Mock).mockResolvedValue([refreshed]);
    const tree = await renderDrawer(harness);
    const refreshControl = (tree.root as Queryable).findAll(
      (node) => node.type === RefreshControl,
    )[0];
    if (typeof refreshControl?.props.onRefresh !== 'function')
      throw new Error('Expected cached refresh control');

    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.listChats).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, forceRefresh: true }),
    );
    expect(hasText(tree.root as Queryable, 'Deep cache newest')).toBe(true);
    act(() => tree.unmount());
  });

  it('settles refreshing through the stream error callback', async () => {
    let streamError: (() => void) | undefined;
    const harness = createHarness({ chats: [listedChat] });
    (harness.api.startChatListStream as jest.Mock)
      .mockImplementationOnce(async (_options, onBatch) => {
        onBatch({ streamId: 'initial', limit: 5, done: true, chats: [listedChat] });
        return { streamId: 'initial', cancel: jest.fn() };
      })
      .mockImplementationOnce(async (_options, _onBatch, onError) => {
        streamError = onError;
        return { streamId: 'refresh', cancel: harness.cancelStream };
      });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const refreshControl = root.findAll((node) => node.type === RefreshControl)[0];
    if (typeof refreshControl?.props.onRefresh !== 'function')
      throw new Error('Expected error refresh control');

    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      await Promise.resolve();
      streamError?.();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('ignores scheduled events while inactive and clears pending work on unmount', async () => {
    const harness = createHarness({ chats: [listedChat] });
    const tree = await renderDrawer(harness);
    await act(async () => {
      harness.emitEvent({ method: 'thread/started', params: { threadId: 'scheduled' } });
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe
              api={harness.api}
              ws={harness.ws}
              active={false}
              selectedChatId={null}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      harness.emitEvent({ method: 'thread/name/updated', params: { threadId: 'scheduled' } });
      await Promise.resolve();
    });
    act(() => tree.unmount());
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(1);
  });

  it('keeps deep loading visible when another completed stream schedules during the in-flight request', async () => {
    let resolveDeep:
      | ((value: { chats: ChatSummary[]; partial: boolean; diagnostics: string[] }) => void)
      | undefined;
    const harness = createHarness({ chats: [listedChat] });
    (harness.api.listAllChats as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveDeep = resolve;
      }),
    );
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
    });
    const refreshControl = root.findAll((node) => node.type === RefreshControl)[0];
    if (typeof refreshControl?.props.onRefresh !== 'function')
      throw new Error('Expected deep refresh control');
    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      await Promise.resolve();
      resolveDeep?.({ chats: [listedChat], partial: false, diagnostics: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.listAllChats).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('ignores deep pages, results, and loaded summaries that settle after deactivation', async () => {
    let onDeepPage: ((chats: ChatSummary[]) => void) | undefined;
    let resolveDeep:
      | ((value: { chats: ChatSummary[]; partial: boolean; diagnostics: string[] }) => void)
      | undefined;
    const deepChat = createChat({ id: 'inactive-deep', title: 'Inactive deep result' });
    const loadedChat = createChat({ id: 'inactive-loaded', title: 'Inactive loaded summary' });
    const harness = createHarness({ chats: [listedChat] });
    (harness.api.listLoadedChatIds as jest.Mock).mockResolvedValue(['inactive-loaded']);
    (harness.api.getChatSummaries as jest.Mock).mockResolvedValue([loadedChat]);
    (harness.api.listAllChats as jest.Mock).mockImplementation(({ onPage }) => {
      onDeepPage = onPage;
      return new Promise((resolve) => {
        resolveDeep = resolve;
      });
    });
    const tree = await renderDrawer(harness);
    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe
              api={harness.api}
              ws={harness.ws}
              active={false}
              selectedChatId={null}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      onDeepPage?.([deepChat]);
      resolveDeep?.({ chats: [deepChat], partial: false, diagnostics: [] });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'Inactive deep result')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Inactive loaded summary')).toBe(true);
    act(() => tree.unmount());
  });

  it('ignores a live stream batch delivered after deactivation', async () => {
    let streamBatch:
      | ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void)
      | undefined;
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    await act(async () => {
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe
              api={harness.api}
              ws={harness.ws}
              active={false}
              selectedChatId={null}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      streamBatch?.({
        streamId: 'stream',
        limit: 5,
        done: true,
        chats: [createChat({ title: 'Late stream row' })],
      });
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'Late stream row')).toBe(false);
    act(() => tree.unmount());
  });
});

describe('DrawerContent partial history diagnostics', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('persists diagnostics and clears them after a forced successful retry', async () => {
    const listAllChats = jest
      .fn()
      .mockResolvedValueOnce({
        chats: [listedChat],
        partial: true,
        diagnostics: ['Chat listing reached the 32-page safety limit.'],
      })
      .mockResolvedValueOnce({ chats: [listedChat], partial: false, diagnostics: [] });
    const api = {
      readBridgeCapabilities: jest.fn().mockResolvedValue({ agents: [], supportsByAgent: {} }),
      peekAllChats: jest.fn().mockReturnValue(null),
      peekChats: jest.fn().mockReturnValue(null),
      rememberChats: jest.fn(),
      listLoadedChatIds: jest.fn().mockResolvedValue([]),
      getChatSummaries: jest.fn().mockResolvedValue([]),
      listChats: jest.fn().mockResolvedValue([listedChat]),
      listAllChats,
      listApprovals: jest.fn().mockResolvedValue([]),
      listPendingUserInputs: jest.fn().mockResolvedValue([]),
      startChatListStream: jest.fn().mockImplementation(async (_options, onBatch) => {
        onBatch({ streamId: 'stream', limit: 20, done: true, chats: [listedChat] });
        return { streamId: 'stream', cancel: jest.fn() };
      }),
    } as unknown as HostBridgeApiClient;
    const ws = {
      isConnected: false,
      onEvent: jest.fn().mockReturnValue(jest.fn()),
      onStatus: jest.fn().mockReturnValue(jest.fn()),
    } as unknown as HostBridgeWsClient;

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <DrawerContentProbe api={api} ws={ws} active selectedChatId={null} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
      await Promise.resolve();
    });
    if (!tree) throw new Error('Expected drawer tree');

    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'Some drawer data may be stale')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Chat listing reached the 32-page safety limit.')).toBe(
      true,
    );

    const retry = (tree.root as Queryable).findAll(
      (node) =>
        node.props.accessibilityLabel === 'Chat listing reached the 32-page safety limit. Retry',
    )[0];
    if (typeof retry?.props.onPress !== 'function') throw new Error('Expected retry action');
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listAllChats).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true }));
    expect(hasText(tree.root as Queryable, 'Some drawer data may be stale')).toBe(false);
    act(() => tree?.unmount());
  });
});

describe('DrawerContent session deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-20T00:30:00.000Z'));
    (ChatSummaryCache.loadChatSummaryCache as jest.Mock).mockImplementation((profileId: string) =>
      Promise.resolve(createEmptyChatSummaryCache(profileId)),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function answerConfirm(answer: 'confirm' | 'cancel'): jest.SpyInstance {
    return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const button = (buttons ?? []).find((candidate) =>
        answer === 'confirm' ? candidate.style === 'destructive' : candidate.style === 'cancel',
      );
      button?.onPress?.();
    });
  }

  function findDeleteAction(root: Queryable, title: string): Queryable {
    const node = root.findAll(
      (candidate) =>
        candidate.props.accessibilityLabel === `Delete ${title}` &&
        typeof candidate.props.onPress === 'function',
    )[0];
    if (!node) throw new Error(`Expected delete action for ${title}`);
    return node;
  }

  it('removes the session from the list once the delete is confirmed', async () => {
    const removePersisted = ChatSummaryCache.deletePersistedChatSummary as jest.Mock;
    const harness = createHarness({
      chats: [createChat({ id: 'a', title: 'Chat a' }), createChat({ id: 'b', title: 'Chat b' })],
    });
    answerConfirm('confirm');
    const tree = await renderDrawer(harness);

    expect(hasText(tree.root as Queryable, 'Chat a')).toBe(true);
    await press(findDeleteAction(tree.root as Queryable, 'Chat a'));

    expect(harness.api.deleteChat).toHaveBeenCalledWith('a');
    expect(hasText(tree.root as Queryable, 'Chat a')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Chat b')).toBe(true);
    expect(removePersisted).toHaveBeenCalledWith('profile-1', 'a');
    act(() => tree.unmount());
  });

  it('keeps the session when the confirmation is dismissed', async () => {
    const harness = createHarness({ chats: [createChat({ id: 'a', title: 'Chat a' })] });
    answerConfirm('cancel');
    const tree = await renderDrawer(harness);

    await press(findDeleteAction(tree.root as Queryable, 'Chat a'));

    expect(harness.api.deleteChat).not.toHaveBeenCalled();
    expect(hasText(tree.root as Queryable, 'Chat a')).toBe(true);
    act(() => tree.unmount());
  });

  it('puts the session back and warns when the agent refuses the delete', async () => {
    const harness = createHarness({
      chats: [
        createChat({ id: 'a', title: 'Chat a' }),
        createChat({ id: 'b', title: 'Chat b', parentThreadId: 'a' }),
        createChat({ id: 'c', title: 'Chat c' }),
      ],
    });
    (harness.api.deleteChat as jest.Mock).mockRejectedValue(new Error('delete unsupported'));
    const alert = answerConfirm('confirm');
    const tree = await renderDrawer(harness);

    await press(findDeleteAction(tree.root as Queryable, 'Chat a'));

    expect(hasText(tree.root as Queryable, 'Chat a')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Chat b')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Chat c')).toBe(true);
    expect(alert).toHaveBeenLastCalledWith(
      'Could not delete session',
      'The session was restored. Check the bridge connection and try again.',
    );
    act(() => tree.unmount());
  });

  it('deletes linked sub-sessions and leaves a selected descendant', async () => {
    const harness = createHarness({
      chats: [
        createChat({ id: 'a', title: 'Parent' }),
        createChat({ id: 'b', title: 'Child', parentThreadId: 'a' }),
        createChat({ id: 'c', title: 'Grandchild', parentThreadId: 'b' }),
        createChat({ id: 'd', title: 'Unrelated' }),
      ],
    });
    const alert = answerConfirm('confirm');
    const store = createDrawerStore(harness.api, harness.ws, { selectedChatId: 'c' });
    const tree = await renderDrawer(harness, { store, selectedChatId: 'c' });

    await press(findDeleteAction(tree.root as Queryable, 'Parent'));

    expect(alert).toHaveBeenCalledWith(
      'Delete session?',
      '“Parent” and 2 linked sub-sessions will be removed from this agent’s history.',
      expect.any(Array),
      expect.any(Object),
    );
    expect(harness.api.deleteChat).toHaveBeenCalledWith('a');
    expect(harness.api.forgetChat).toHaveBeenCalledWith('b');
    expect(harness.api.forgetChat).toHaveBeenCalledWith('c');
    expect(hasText(tree.root as Queryable, 'Parent')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Child')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Grandchild')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Unrelated')).toBe(true);
    expect(store.get(selectedChatIdAtom)).toBeNull();
    act(() => tree.unmount());
  });

  it('starts a new chat when the session being viewed is deleted', async () => {
    const harness = createHarness({ chats: [createChat({ id: 'a', title: 'Chat a' })] });
    answerConfirm('confirm');
    const store = createDrawerStore(harness.api, harness.ws, { selectedChatId: 'a' });
    const tree = await renderDrawer(harness, { store, selectedChatId: 'a' });

    await press(findDeleteAction(tree.root as Queryable, 'Chat a'));

    expect(store.get(selectedChatIdAtom)).toBeNull();
    act(() => tree.unmount());
  });

  it('lets the bridge decide even when cached agent capabilities say delete is unsupported', async () => {
    const harness = createHarness({
      chats: [createChat({ id: 'a', title: 'Chat a', agentId: 'codex' })],
      agents: [
        {
          agentId: 'codex',
          displayName: 'Codex',
          version: '1',
          provenance: 'test',
          lifecycle: 'ready',
          capabilities: {
            sessionList: true,
            sessionLoad: true,
            sessionResume: true,
            sessionSteer: false,
            sessionDelete: false,
          },
        },
      ],
    });
    const alert = answerConfirm('confirm');
    const tree = await renderDrawer(harness);

    await press(findDeleteAction(tree.root as Queryable, 'Chat a'));

    expect(harness.api.deleteChat).toHaveBeenCalledWith('a');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      'Delete session?',
      '“Chat a” will be removed from this agent’s history.',
      expect.any(Array),
      expect.any(Object),
    );
    expect(hasText(tree.root as Queryable, 'Chat a')).toBe(false);
    act(() => tree.unmount());
  });

  it('drops a session that another client deleted', async () => {
    const harness = createHarness({
      chats: [createChat({ id: 'a', title: 'Chat a' }), createChat({ id: 'b', title: 'Chat b' })],
    });
    const tree = await renderDrawer(harness);

    await act(async () => {
      harness.emitEvent({ method: 'thread/deleted', params: { threadId: 'a' } });
      await Promise.resolve();
    });

    expect(harness.api.forgetChat).toHaveBeenCalledWith('a');
    expect(hasText(tree.root as Queryable, 'Chat a')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Chat b')).toBe(true);
    act(() => tree.unmount());
  });

  it('ignores a deletion event without a thread id', async () => {
    const harness = createHarness({ chats: [createChat({ id: 'a', title: 'Chat a' })] });
    const tree = await renderDrawer(harness);

    await act(async () => {
      harness.emitEvent({ method: 'thread/deleted', params: {} });
      await Promise.resolve();
    });

    expect(harness.api.forgetChat).not.toHaveBeenCalled();
    expect(hasText(tree.root as Queryable, 'Chat a')).toBe(true);
    act(() => tree.unmount());
  });
});

describe('DrawerContent session search', () => {
  function searchInput(root: Queryable): Queryable {
    return findByLabel(root, 'Search sessions');
  }

  async function typeSearch(root: Queryable, value: string): Promise<void> {
    await act(async () => {
      (searchInput(root).props.onChangeText as (value: string) => void)(value);
      await Promise.resolve();
    });
  }

  it('dismisses the search keyboard before starting a new chat', async () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const harness = createHarness({
      chats: [createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' })],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await typeSearch(root, 'alpha');
    await press(findByLabel(root, 'New chat'));

    expect(dismissSpy).toHaveBeenCalledTimes(1);

    dismissSpy.mockRestore();
    act(() => tree.unmount());
  });

  it('matches sessions case-insensitively across title, workspace, agent, and status', async () => {
    const harness = createHarness({
      chats: [
        createChat({ id: 'alpha', title: 'Fix login bug', cwd: '/repo/alpha', agentId: 'copilot' }),
        createChat({ id: 'beta', title: 'Refactor db layer', cwd: '/repo/beta', agentId: 'codex' }),
        createChat({
          id: 'gamma',
          title: 'Unrelated task',
          cwd: '/repo/gamma',
          agentId: 'copilot',
          status: 'error',
          lastError: 'boom',
        }),
      ],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await typeSearch(root, 'LOGIN');
    expect(hasText(root, 'Fix login bug')).toBe(true);
    expect(hasText(root, 'Refactor db layer')).toBe(false);
    expect(hasText(root, 'Unrelated task')).toBe(false);

    await typeSearch(root, 'beta');
    expect(hasText(root, 'Refactor db layer')).toBe(true);
    expect(hasText(root, 'Fix login bug')).toBe(false);

    await typeSearch(root, 'codex');
    expect(hasText(root, 'Refactor db layer')).toBe(true);
    expect(hasText(root, 'Fix login bug')).toBe(false);

    await typeSearch(root, 'failed');
    expect(hasText(root, 'Unrelated task')).toBe(true);
    expect(hasText(root, 'Fix login bug')).toBe(false);
    act(() => tree.unmount());
  });

  it('preserves urgency lane grouping and order for search matches', async () => {
    const harness = createHarness({
      chats: [
        createChat({ id: 'attn', title: 'Zeta approval chat', cwd: '/repo/z' }),
        createChat({ id: 'work', title: 'Zeta working chat', cwd: '/repo/z', status: 'running' }),
        createChat({ id: 'rest', title: 'Zeta recent chat', cwd: '/repo/z' }),
      ],
      approvals: [createApproval('attn')],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await typeSearch(root, 'zeta');

    expect(findByLabel(root, 'Needs your attention, 1 session')).toBeDefined();
    expect(findByLabel(root, 'Working now, 1 session')).toBeDefined();
    expect(findByLabel(root, 'Recent, 1 session')).toBeDefined();
    act(() => tree.unmount());
  });

  it('forces a previously collapsed lane header to report expanded while a search reveals its matches', async () => {
    const harness = createHarness({
      chats: [
        createChat({ id: 'first', title: 'First recent', cwd: '/repo/first' }),
        createChat({ id: 'second', title: 'Second recent', cwd: '/repo/second' }),
      ],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    // Collapse the "Recent" lane before searching.
    await press(findByLabel(root, 'Recent, 2 sessions'));
    expect(findByLabel(root, 'Recent, 2 sessions').props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: false }),
    );
    expect(hasText(root, 'First recent')).toBe(false);

    await typeSearch(root, 'first');

    // Rows for the match render (the search bypasses collapse-filtering), so the header must
    // now claim expanded too, not still say collapsed while its rows are visibly showing.
    expect(findByLabel(root, 'Recent, 1 session').props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: true }),
    );
    expect(hasText(root, 'First recent')).toBe(true);

    await press(findByLabel(root, 'Clear search'));

    // Clearing the search restores the user's manual collapse preference.
    expect(findByLabel(root, 'Recent, 2 sessions').props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: false }),
    );
    expect(hasText(root, 'First recent')).toBe(false);
    act(() => tree.unmount());
  });

  it('shows a distinct no-results state without hiding the offline notice or connection footer', async () => {
    const harness = createHarness({
      chats: [createChat({ id: 'a', title: 'Alpha chat', cwd: '/repo/a' })],
      connected: false,
    });
    (harness.api.readBridgeCapabilities as jest.Mock).mockRejectedValueOnce(
      new Error('capabilities failed'),
    );
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await typeSearch(root, 'nonexistent-session');
    expect(hasText(root, 'No sessions match')).toBe(true);
    expect(hasText(root, 'Alpha chat')).toBe(false);
    expect(findByLabel(root, 'Could not refresh agent names. Retry')).toBeDefined();
    expect(findByLabel(root, 'Bridge offline. Reconnect or edit connection')).toBeDefined();
    act(() => tree.unmount());
  });

  it('clears the query, restores the full list, and confirms the field is empty', async () => {
    const harness = createHarness({
      chats: [
        createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' }),
        createChat({ id: 'beta', title: 'Beta chat', cwd: '/repo/beta' }),
      ],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await typeSearch(root, 'alpha');
    expect(hasText(root, 'Beta chat')).toBe(false);

    await press(findByLabel(root, 'Clear search'));
    expect(hasText(root, 'Alpha chat')).toBe(true);
    expect(hasText(root, 'Beta chat')).toBe(true);
    expect(searchInput(root).props.value).toBe('');
    act(() => tree.unmount());
  });

  it('keeps a live-search query stable and current as drawer data streams updates', async () => {
    let streamBatch:
      | ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void)
      | undefined;
    const alpha = createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' });
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      onBatch({ streamId: 'stream', limit: 5, done: false, chats: [alpha] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await typeSearch(root, 'alpha');
    expect(hasText(root, 'Alpha chat')).toBe(true);

    const beta = createChat({ id: 'beta', title: 'Beta chat', cwd: '/repo/beta' });
    await act(async () => {
      streamBatch?.({ streamId: 'stream', limit: 20, done: false, chats: [alpha, beta] });
      await Promise.resolve();
    });

    expect(searchInput(root).props.value).toBe('alpha');
    expect(hasText(root, 'Alpha chat')).toBe(true);
    expect(hasText(root, 'Beta chat')).toBe(false);
    act(() => tree.unmount());
  });

  async function settleSearchAnnouncementDebounce(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
  }

  it('announces the debounced result count to screen readers once typing settles', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation();
    const harness = createHarness({
      chats: [createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' })],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await typeSearch(root, 'alpha');
    // The single announcement channel is debounced: nothing fires until typing settles.
    expect(announce).not.toHaveBeenCalled();
    await settleSearchAnnouncementDebounce();
    expect(announce).toHaveBeenCalledWith('1 session matches "alpha"');
    expect(announce).toHaveBeenCalledTimes(1);

    await typeSearch(root, 'nonexistent');
    await settleSearchAnnouncementDebounce();
    expect(announce).toHaveBeenCalledWith('No sessions match "nonexistent"');
    expect(announce).toHaveBeenCalledTimes(2);

    announce.mockRestore();
    act(() => tree.unmount());
  });

  it('coalesces rapid keystrokes into a single announcement instead of one per keystroke', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation();
    const harness = createHarness({
      chats: [createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' })],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    // Simulate fast typing: each keystroke lands well inside the debounce window of the last.
    await act(async () => {
      (searchInput(root).props.onChangeText as (value: string) => void)('a');
      await new Promise((resolve) => setTimeout(resolve, 50));
      (searchInput(root).props.onChangeText as (value: string) => void)('al');
      await new Promise((resolve) => setTimeout(resolve, 50));
      (searchInput(root).props.onChangeText as (value: string) => void)('alp');
      await new Promise((resolve) => setTimeout(resolve, 50));
      (searchInput(root).props.onChangeText as (value: string) => void)('alpha');
    });

    expect(announce).not.toHaveBeenCalled();
    await settleSearchAnnouncementDebounce();

    // Only the final, settled query is announced — never the intermediate keystrokes.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('1 session matches "alpha"');

    announce.mockRestore();
    act(() => tree.unmount());
  });

  it('keeps a single announcement channel by omitting live regions from the visual search summary and empty state', async () => {
    const harness = createHarness({
      chats: [createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' })],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await typeSearch(root, 'alpha');
    const summaryText = root.findAll(
      (node) => textContent(node as Queryable).includes('session matches "alpha"') && node.type === Text,
    )[0];
    expect(summaryText?.props.accessibilityLiveRegion).toBeUndefined();

    await typeSearch(root, 'nonexistent');
    const emptyStateView = root.findAll(
      (node) => node.props.accessibilityLiveRegion !== undefined && hasText(node as Queryable, 'No sessions match'),
    )[0];
    expect(emptyStateView?.props.accessibilityLiveRegion).toBe('none');

    act(() => tree.unmount());
  });

  it('exposes an accessible label, hint, and a reachable clear action on the search field', async () => {
    const harness = createHarness({
      chats: [createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' })],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const input = searchInput(root);
    expect(input.props.accessibilityLabel).toBe('Search sessions');
    expect(input.props.accessibilityHint).toContain('Filters sessions');
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Clear search'),
    ).toHaveLength(0);

    await typeSearch(root, 'alpha');
    const clearButton = findByLabel(root, 'Clear search');
    expect(clearButton.props.accessibilityRole).toBe('button');
    act(() => tree.unmount());
  });

  it('sizes the search field container to the platform touch-target minimum, not a spacing token', () => {
    const flattened = StyleSheet.flatten(createDrawerContentStyles(theme).searchField);
    expect(flattened.minHeight).toBe(theme.touchTarget.minimum);
    expect(flattened.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('sizes the lane header to the platform touch-target minimum, including 48dp on Android', () => {
    const flattenedDefault = StyleSheet.flatten(createDrawerContentStyles(theme).laneHeader);
    expect(flattenedDefault.minHeight).toBe(theme.touchTarget.minimum);

    const originalOS = Platform.OS;
    Platform.OS = 'android';
    try {
      const androidTheme = createAppTheme('dark');
      expect(androidTheme.touchTarget.minimum).toBe(48);
      const flattenedAndroid = StyleSheet.flatten(createDrawerContentStyles(androidTheme).laneHeader);
      expect(flattenedAndroid.minHeight).toBe(48);
    } finally {
      Platform.OS = originalOS;
    }
  });

  it('does not hide the offline notice or connection footer while a search matches', async () => {
    const harness = createHarness({
      chats: [createChat({ id: 'alpha', title: 'Alpha chat', cwd: '/repo/alpha' })],
      connected: false,
    });
    (harness.api.readBridgeCapabilities as jest.Mock).mockRejectedValueOnce(
      new Error('capabilities failed'),
    );
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await typeSearch(root, 'alpha');
    expect(hasText(root, 'Alpha chat')).toBe(true);
    expect(findByLabel(root, 'Could not refresh agent names. Retry')).toBeDefined();
    expect(findByLabel(root, 'Bridge offline. Reconnect or edit connection')).toBeDefined();
    act(() => tree.unmount());
  });

  it('opens the connection editor from the drawer footer without routing through a chat', async () => {
    const harness = createHarness({ connected: false });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Bridge offline. Reconnect or edit connection'));
    expect(router.push).toHaveBeenCalledWith(routes.settingsConnection('profile-1', 'edit'), {
      withAnchor: true,
    });
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
