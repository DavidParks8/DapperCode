import { Provider, createStore } from 'jotai';
import { createRef } from 'react';
import renderer, { act } from 'react-test-renderer';

import { createAgUiThreadMessageState } from '../../api/agUiMessagesState';
import { liveAssistantByThreadAtom } from '../../state/mainScreen/turn';
import { MainScreenTranscriptAndSheets } from './MainScreenTranscriptAndSheets';

const mockTranscriptProps: Array<Record<string, unknown>> = [];

jest.mock('./ChatTranscriptView', () => ({
  ChatTranscriptView: (props: Record<string, unknown>) => {
    mockTranscriptProps.push(props);
    return null;
  },
}));
jest.mock('./useMainScreenStyles', () => ({
  useMainScreenStyles: () => ({
    styles: {
      bodyContainer: {},
      keyboardAvoiding: {},
      floatingActivity: {},
    },
  }),
}));
jest.mock('../../components/ActivityBar', () => ({ ActivityBar: () => null }));
jest.mock('../../components/SelectionSheet', () => ({ SelectionSheet: () => null }));
jest.mock('./MainScreenPresentation', () => ({
  ComposeView: () => null,
  ChatOpeningView: () => null,
}));

describe('MainScreenTranscriptAndSheets', () => {
  it('keeps the load-earlier callback stable while streamed state changes', () => {
    const store = createStore();
    const handleLoadEarlier = jest.fn(async () => undefined);
    const context = {
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
      androidComposerReservedInset: 0,
      transcriptContinuationState: undefined,
      handleLoadEarlier,
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
      chatBottomInset: 0,
      showFloatingActivity: false,
      displayedActivity: { tone: 'running', title: 'Working' },
      activityDetail: undefined,
      attachmentMenuVisible: false,
      attachmentMenuOptions: [],
      attachmentController: { closeMenu: jest.fn() },
      agentThreadMenuOptions: [],
      collaborationModeOptions: [],
      agentPickerOptions: [],
      closeAgentModal: jest.fn(),
    };

    act(() => {
      renderer.create(
        <Provider store={store}>
          <MainScreenTranscriptAndSheets context={context as never} />
        </Provider>,
      );
    });
    const first = mockTranscriptProps.at(-1)?.onLoadEarlier;

    act(() => {
      store.set(liveAssistantByThreadAtom, {
        thread: {
          ...createAgUiThreadMessageState(),
          messages: [{ id: 'live', role: 'assistant', content: 'A', createdAt: '' }],
        },
      });
    });

    expect(mockTranscriptProps.at(-1)?.onLoadEarlier).toBe(first);
    expect(first).not.toBe(handleLoadEarlier);
  });
});
