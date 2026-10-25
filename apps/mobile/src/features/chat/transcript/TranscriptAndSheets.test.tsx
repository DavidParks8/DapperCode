import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Provider, createStore } from 'jotai';
import { createRef } from 'react';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';

import { createAgUiThreadMessageState } from '@bridge/agui/agUiMessagesState';
import { keyboardInsetAtom, keyboardVisibleAtom, topChromeHeightAtom } from '../state/composer';
import { liveAssistantByThreadAtom } from '../state/turn';
import { windowTraitsAtom } from '@shell/state/layout/atoms';
import { MainScreenTranscriptAndSheets } from './TranscriptAndSheets';

type Queryable = ReactTestInstance & {
  type: unknown;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

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
      bodyShell: {},
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

  it('never stacks keyboard avoidance on top of the measured composer inset', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const store = createStore();
    store.set(keyboardVisibleAtom, true);
    store.set(keyboardInsetAtom, 336);
    const renderComposer = jest.fn(() => null);
    // The composer overlay already floats on the keyboard inset and `composerReservedInset` folds
    // that same inset into the transcript, so a KeyboardAvoidingView here would shrink the shell by
    // a second keyboard height and shove short transcripts off screen.
    const context = createContext({
      composerReservedInset: 432,
      renderComposer,
      shouldShowComposer: true,
    });
    let tree: ReturnType<typeof renderer.create> | undefined;

    act(() => {
      tree = renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets context={context as never} />
        </Provider>,
      );
    });

    const keyboardAvoiders = (tree?.root as Queryable | undefined)?.findAll(
      (node) => node.type === KeyboardAvoidingView,
    );
    expect(keyboardAvoiders).toHaveLength(0);
    expect(mockTranscriptProps.at(-1)?.['bottomInset']).toBe(432);
    act(() => tree?.unmount());
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

  it('keeps the transcript and composer clear of the iPhone Duo status column', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const store = createStore();
    store.set(windowTraitsAtom, {
      horizontalSizeClass: 'compact',
      verticalSizeClass: 'regular',
      divisions: [],
    });
    const renderComposer = jest.fn(() => null);
    const context = createContext({ renderComposer, shouldShowComposer: true });
    let tree: ReturnType<typeof renderer.create> | undefined;

    act(() => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 466, height: 678 },
            insets: { top: 0, left: 12, right: 84, bottom: 20 },
          }}
        >
          <Provider store={store}>
            <MainScreenTranscriptAndSheets context={context as never} />
          </Provider>
        </SafeAreaProvider>,
      );
    });
    const bodyStyle = () =>
      StyleSheet.flatten(
        (tree?.root as Queryable).findAll(
          (node) => node.props['testID'] === 'chat-body' && typeof node.type !== 'string',
        )[0]?.props['style'] as never,
      );

    // Closed: the composer overlay lives inside this body, so the Send button stays out of the
    // vertical status bar and camera column.
    expect(renderComposer).toHaveBeenCalledWith(true);
    expect(bodyStyle()).toMatchObject({ paddingLeft: 12, paddingRight: 84 });

    // Open with a docked sidebar: the sidebar owns the leading edge.
    act(() => {
      store.set(windowTraitsAtom, {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'compact',
        divisions: [],
      });
    });
    expect(bodyStyle()).toMatchObject({ paddingLeft: 0, paddingRight: 84 });

    // Folded like a book: the session list moves behind the menu and the chat keeps the full
    // width, so it pads the leading edge itself again.
    act(() => {
      store.set(windowTraitsAtom, {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'compact',
        divisions: [{ x: 300, y: 0, width: 41, height: 669 }],
      });
    });
    expect(bodyStyle()).toMatchObject({ paddingLeft: 12, paddingRight: 84 });

    act(() => tree?.unmount());
  });

  it('moves the chrome above the composer on a device folded like a laptop', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const store = createStore();
    store.set(topChromeHeightAtom, 80);
    const context = createContext({
      composerReservedInset: 88,
      renderComposer: jest.fn(() => null),
      shouldShowComposer: true,
    });
    let tree: ReturnType<typeof renderer.create> | undefined;
    act(() => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 669, height: 951 },
            insets: { top: 30, left: 0, right: 0, bottom: 20 },
          }}
        >
          <Provider store={store}>
            <MainScreenTranscriptAndSheets context={context as never} />
          </Provider>
        </SafeAreaProvider>,
      );
    });
    // Flat: the chrome is at the top.
    expect(mockTranscriptProps.at(-1)).toMatchObject({ topInset: 80, bottomInset: 88 });

    // Laptop pose: the controls sit on the lower half, directly above the composer, so the
    // transcript clears them at the bottom and only the safe area at the top.
    act(() => {
      store.set(windowTraitsAtom, {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        divisions: [{ x: 0, y: 455.5, width: 669, height: 40 }],
      });
    });
    expect(mockTranscriptProps.at(-1)).toMatchObject({ topInset: 30, bottomInset: 88 + 80 });
    act(() => tree?.unmount());
  });
});
