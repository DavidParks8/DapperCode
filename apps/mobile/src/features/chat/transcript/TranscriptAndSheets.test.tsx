import { Platform } from 'react-native';
import { Provider, createStore } from 'jotai';
import { createRef } from 'react';
import renderer, { act } from 'react-test-renderer';

import { createAgUiThreadMessageState } from '@bridge/agui/agUiMessagesState';
import { topChromeHeightAtom } from '../state/composer';
import { liveAssistantByThreadAtom } from '../state/turn';
import { MainScreenTranscriptAndSheets } from './TranscriptAndSheets';

const mockTranscriptProps: Array<Record<string, unknown>> = [];
const mockComposeProps: Array<Record<string, unknown>> = [];
const mockOpeningProps: Array<Record<string, unknown>> = [];

jest.mock('./ChatTranscriptView', () => ({
  ChatTranscriptView: (props: Record<string, unknown>) => {
    mockTranscriptProps.push(props);
    return null;
  },
}));
jest.mock('../styles/useStyles', () => ({
  useMainScreenStyles: () => ({
    styles: {
      bodyContainer: {},
      keyboardAvoiding: {},
    },
  }),
}));
jest.mock('@shared/ui/SelectionSheet', () => ({ SelectionSheet: () => null }));
jest.mock('../screen/Presentation', () => ({
  ComposeView: (props: Record<string, unknown>) => {
    mockComposeProps.push(props);
    return null;
  },
  ChatOpeningView: (props: Record<string, unknown>) => {
    mockOpeningProps.push(props);
    return null;
  },
}));

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    selectedChat: {
      id: 'thread',
      title: 'Thread',
      status: 'running',
      createdAt: '',
      updatedAt: '',
      statusUpdatedAt: '',
      lastMessagePreview: '',
      messages: [],
    },
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
    autoScrollStateRef: { current: { isPinned: true, isUserInteracting: false } },
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
    renderComposer: jest.fn(),
    showTranscriptActivity: false,
    displayedActivity: { tone: 'running', title: 'Working' },
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

describe('MainScreenTranscriptAndSheets', () => {
  const originalPlatformOs = Platform.OS;

  beforeEach(() => {
    mockTranscriptProps.length = 0;
    mockComposeProps.length = 0;
    mockOpeningProps.length = 0;
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
  });

  it('keeps the load-earlier callback stable while streamed state changes', () => {
    const store = createStore();
    const handleLoadEarlier = jest.fn(async () => undefined);
    const context = createContext({ handleLoadEarlier });

    act(() => {
      renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets context={context as never} />
        </Provider>,
      );
    });
    const first = mockTranscriptProps.at(-1)?.['onLoadEarlier'];

    act(() => {
      store.set(liveAssistantByThreadAtom, {
        thread: {
          ...createAgUiThreadMessageState(),
          messages: [{ id: 'live', role: 'assistant', content: 'A', createdAt: '' }],
        },
      });
    });

    expect(mockTranscriptProps.at(-1)?.['onLoadEarlier']).toBe(first);
    expect(first).not.toBe(handleLoadEarlier);
  });

  it('overlays the iOS composer and reserves its measured height in the transcript', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const store = createStore();
    const renderComposer = jest.fn(() => null);
    const context = createContext({
      composerReservedInset: 88,
      renderComposer,
      shouldShowComposer: true,
    });

    act(() => {
      renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets context={context as never} />
        </Provider>,
      );
    });

    expect(renderComposer).toHaveBeenCalledWith(true);
    expect(mockTranscriptProps.at(-1)?.['bottomInset']).toBe(88);
  });

  it('routes the live status into the transcript instead of the composer overlay', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const store = createStore();
    const renderComposer = jest.fn(() => null);
    const displayedActivity = {
      tone: 'running',
      title: 'Editing file',
      detail: 'src/main.ts',
    };
    const context = createContext({
      displayedActivity,
      renderComposer,
      shouldShowComposer: true,
      showTranscriptActivity: true,
    });

    act(() => {
      renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets context={context as never} />
        </Provider>,
      );
    });

    expect(mockTranscriptProps.at(-1)?.['activity']).toBe(displayedActivity);
    expect(renderComposer).toHaveBeenCalledWith(true);
  });

  it('keeps the web composer in flow instead of dropping it during native overlay handling', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const store = createStore();
    const renderComposer = jest.fn(() => null);
    const context = createContext({
      composerReservedInset: 88,
      renderComposer,
      shouldShowComposer: true,
    });

    act(() => {
      renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets context={context as never} />
        </Provider>,
      );
    });

    expect(renderComposer).toHaveBeenCalledWith(false);
    expect(mockTranscriptProps.at(-1)?.['bottomInset']).toBe(0);
  });

  it('keeps compose and opening content clear of the measured top chrome', () => {
    const store = createStore();
    store.set(topChromeHeightAtom, 72);
    let composeTree: ReturnType<typeof renderer.create> | undefined;
    let openingTree: ReturnType<typeof renderer.create> | undefined;

    act(() => {
      composeTree = renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets context={createContext({ selectedChat: null }) as never} />
        </Provider>,
      );
    });
    expect(mockComposeProps.at(-1)?.['topInset']).toBe(72);

    act(() => {
      openingTree = renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets
            context={createContext({ isOpeningChat: true }) as never}
          />
        </Provider>,
      );
    });
    expect(mockOpeningProps.at(-1)?.['topInset']).toBe(72);
    act(() => {
      composeTree?.unmount();
      openingTree?.unmount();
    });
  });
});
