import fs from 'node:fs';
import path from 'node:path';

import { Provider, createStore } from 'jotai';
import { createRef } from 'react';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { BridgeCapabilities, Chat } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { MainScreenTranscriptAndSheets } from './TranscriptAndSheets';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('@shared/testing/gestureHandlerMock'),
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../styles/useStyles', () => ({
  useMainScreenStyles: () => ({ styles: { bodyContainer: {}, bodyShell: {} } }),
}));
jest.mock('@shared/ui/SelectionSheet', () => ({ SelectionSheet: () => null }));
jest.mock('../screen/Presentation', () => ({
  ComposeView: () => null,
  ChatOpeningView: () => null,
}));

type Queryable = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

const FORK_LABEL = 'Fork conversation from here';
const theme = createAppTheme('dark');

function contractManifest(): {
  fixtures: {
    capabilities: BridgeCapabilities;
    capabilityCases: Array<{ name: string; supportsByAgent: Record<string, boolean> }>;
  };
} {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../../contracts/bridge-rpc/v2/manifest.json'),
      'utf8',
    ),
  );
}

/**
 * The bridge is the only source of truth for what an agent supports, so the capability payload the
 * app reacts to is read straight out of the shared contract fixture instead of being hand-written.
 */
function contractCapabilities(): BridgeCapabilities {
  return contractManifest().fixtures.capabilities;
}

function contractCapabilityCase(name: string): { supportsByAgent: Record<string, boolean> } {
  const match = contractManifest().fixtures.capabilityCases.find((entry) => entry.name === name);
  if (!match) {
    throw new Error(`Missing contract capability case: ${name}`);
  }
  return match;
}

const settledChat: Chat = {
  id: 'thread',
  title: 'Fork affordance',
  status: 'complete',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:03.000Z',
  statusUpdatedAt: '2026-09-01T00:00:03.000Z',
  lastMessagePreview: 'Latest answer',
  messages: [
    { id: 'user-1', role: 'user', content: 'First', createdAt: '2026-09-01T00:00:00.000Z' },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First answer',
      createdAt: '2026-09-01T00:00:01.000Z',
    },
    { id: 'user-2', role: 'user', content: 'Second', createdAt: '2026-09-01T00:00:02.000Z' },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Latest answer',
      createdAt: '2026-09-01T00:00:03.000Z',
    },
  ],
};

function createContext(overrides: Record<string, unknown>) {
  return {
    selectedChat: settledChat,
    isOpeningChat: false,
    selectedParentChat: null,
    bridgeUrl: 'http://bridge',
    bridgeToken: null,
    onOpenLocalPreview: jest.fn(),
    openAgentDetail: jest.fn(),
    showToolCalls: true,
    agentThreadStatusById: new Map(),
    scrollRef: createRef(),
    isLoading: false,
    handleInlineOptionSelect: jest.fn(),
    scrollToBottomIfPinned: jest.fn(),
    handleJumpToLatest: jest.fn(),
    clearPendingScrollRetries: jest.fn(),
    autoScrollStateRef: {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    },
    composerReservedInset: 0,
    transcriptContinuationState: undefined,
    handleLoadEarlier: jest.fn(async () => undefined),
    defaultStartWorkspaceLabel: '',
    readyAgents: [],
    activeAgentLabel: 'Agent',
    modelOptions: [],
    activeModelLabel: '',
    activeModelEffortOptions: [],
    activeEffortLabel: '',
    collaborationModeLabel: '',
    supportsFastMode: false,
    fastModeEnabled: false,
    fastModeLabel: '',
    setDraft: jest.fn(),
    openWorkspaceModal: jest.fn(),
    openAgentModal: jest.fn(),
    openModelModal: jest.fn(),
    openEffortModal: jest.fn(),
    openCollaborationModeMenu: jest.fn(),
    toggleFastMode: jest.fn(),
    shouldShowComposer: false,
    renderComposer: jest.fn(() => null),
    showTranscriptActivity: false,
    displayedActivity: { tone: 'idle', title: '' },
    attachmentMenuVisible: false,
    attachmentMenuOptions: [],
    attachmentController: { closeMenu: jest.fn() },
    agentThreadMenuOptions: [],
    collaborationModeOptions: [],
    agentPickerOptions: [],
    closeAgentModal: jest.fn(),
    ...overrides,
  };
}

function renderScreen(overrides: Record<string, unknown>): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <Provider store={createStore()}>
        <AppThemeProvider theme={theme}>
          <MainScreenTranscriptAndSheets context={createContext(overrides) as never} />
        </AppThemeProvider>
      </Provider>,
    );
  });
  if (!tree) {
    throw new Error('Expected the transcript screen to render');
  }
  return tree;
}

function forkButtonsByMessageId(tree: ReactTestRenderer): Map<string, Queryable> {
  const buttons = new Map<string, Queryable>();
  for (const node of (tree.root as Queryable).findAll(
    (candidate) =>
      typeof candidate.props['onPress'] === 'function' &&
      candidate.props['accessibilityLabel'] === FORK_LABEL,
  )) {
    const testID = node.props['testID'];
    if (typeof testID === 'string') {
      buttons.set(testID.replace(/^chat-message-copy-/, '').replace(/-fork$/, ''), node);
    }
  }
  return buttons;
}

describe('conversation fork affordance end to end', () => {
  it('shows the fork button on the newest response and forks the whole conversation', async () => {
    const capabilities = contractCapabilities();
    const agentId = capabilities.activeAgentId;
    if (!agentId) {
      throw new Error('Expected the contract fixture to name an active agent');
    }
    const forkChat = jest.fn().mockResolvedValue({ id: 'forked' });
    const forkConversation = jest.fn(async (messageId: string) => forkChat(messageId));
    const tree = renderScreen({
      activeAgentSupports: capabilities.supportsByAgent[agentId],
      forkConversation,
    });

    const buttons = forkButtonsByMessageId(tree);
    expect([...buttons.keys()].sort()).toEqual(['assistant-1', 'assistant-2']);

    const newest = buttons.get('assistant-2');
    await act(async () => {
      (newest?.props['onPress'] as () => void)();
      await Promise.resolve();
    });

    // The newest response names itself, which the bridge resolves to the end of history.
    expect(forkChat).toHaveBeenCalledWith('assistant-2');
    act(() => tree.unmount());
  });

  it('offers nothing when the agent cannot fork at all', () => {
    const unsupported = contractCapabilityCase('unsupportedOperations');
    const tree = renderScreen({
      activeAgentSupports: unsupported.supportsByAgent,
      forkConversation: jest.fn(async () => undefined),
    });

    expect([...forkButtonsByMessageId(tree).keys()]).toEqual([]);
    act(() => tree.unmount());
  });
});
