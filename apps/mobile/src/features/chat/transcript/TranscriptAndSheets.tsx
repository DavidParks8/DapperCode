import { useMainScreenStyles } from '../styles/useStyles';
import {
  liveAssistantByThreadAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
} from '../state/turn';
import { loadingAgentThreadsAtom } from '../../workspace/state/workspace';
import { keyboardVisibleAtom, topChromeHeightAtom } from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import { Platform, View } from 'react-native';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';
import { ComposeView } from '../screen/Presentation';
import { ChatOpeningView } from '../screen/Presentation';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from '../screen/panelCollapseCoordinator';
import {
  agentModalVisibleAtom,
  agentThreadMenuVisibleAtom,
  collaborationModeMenuVisibleAtom,
} from '../state/modals';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

type BodyContentProps = Pick<
  Context,
  | 'selectedChat'
  | 'isOpeningChat'
  | 'selectedParentChat'
  | 'bridgeUrl'
  | 'bridgeToken'
  | 'onOpenLocalPreview'
  | 'openAgentDetail'
  | 'showToolCalls'
  | 'agentThreadStatusById'
  | 'scrollRef'
  | 'isLoading'
  | 'handleInlineOptionSelect'
  | 'scrollToBottomIfPinned'
  | 'handleJumpToLatest'
  | 'clearPendingScrollRetries'
  | 'autoScrollStateRef'
  | 'transcriptContinuationState'
  | 'handleLoadEarlier'
  | 'defaultStartWorkspaceLabel'
  | 'readyAgents'
  | 'activeAgentLabel'
  | 'activeAgentSupports'
  | 'modelOptions'
  | 'activeModelLabel'
  | 'activeModelEffortOptions'
  | 'activeEffortLabel'
  | 'collaborationModeLabel'
  | 'supportsFastMode'
  | 'fastModeEnabled'
  | 'fastModeLabel'
  | 'setDraft'
  | 'openWorkspaceModal'
  | 'openAgentModal'
  | 'openModelModal'
  | 'openEffortModal'
  | 'openCollaborationModeMenu'
  | 'toggleFastMode'
  | 'forkConversation'
> & {
  pendingApproval: unknown;
  pendingUserInputRequest: unknown;
  liveMessageState: ChatTranscriptViewProps['liveMessageState'];
  keyboardVisible: boolean;
  bottomInset: number;
  topInset: number;
  activity: ChatTranscriptViewProps['activity'];
};

type SelectionSheetsProps = Pick<
  Context,
  | 'attachmentMenuVisible'
  | 'attachmentMenuOptions'
  | 'attachmentController'
  | 'agentThreadMenuOptions'
  | 'collaborationModeOptions'
  | 'agentPickerOptions'
  | 'closeAgentModal'
  | 'activeAgentLabel'
> & {
  agentModalVisible: boolean;
  agentThreadMenuVisible: boolean;
  collaborationModeMenuVisible: boolean;
  loadingAgentThreads: boolean;
  setAgentThreadMenuVisible: (visible: boolean) => void;
  setCollaborationModeMenuVisible: (visible: boolean) => void;
};

function TranscriptOrComposerContent({
  selectedChat,
  isOpeningChat,
  selectedParentChat,
  bridgeUrl,
  bridgeToken,
  onOpenLocalPreview,
  openAgentDetail,
  showToolCalls,
  agentThreadStatusById,
  scrollRef,
  isLoading,
  pendingApproval,
  pendingUserInputRequest,
  handleInlineOptionSelect,
  scrollToBottomIfPinned,
  handleJumpToLatest,
  clearPendingScrollRetries,
  autoScrollStateRef,
  bottomInset,
  topInset,
  liveMessageState,
  transcriptContinuationState,
  handleLoadEarlier,
  defaultStartWorkspaceLabel,
  readyAgents,
  activeAgentLabel,
  activeAgentSupports,
  modelOptions,
  activeModelLabel,
  activeModelEffortOptions,
  activeEffortLabel,
  collaborationModeLabel,
  supportsFastMode,
  fastModeEnabled,
  fastModeLabel,
  keyboardVisible,
  activity,
  setDraft,
  openWorkspaceModal,
  openAgentModal,
  openModelModal,
  openEffortModal,
  openCollaborationModeMenu,
  toggleFastMode,
  forkConversation,
}: BodyContentProps) {
  const handleLoadEarlierPress = useCallback(() => {
    void handleLoadEarlier();
  }, [handleLoadEarlier]);

  if (selectedChat && !isOpeningChat) {
    return (
      <ChatTranscriptView
        key={selectedChat.id}
        chat={selectedChat}
        parentChat={selectedParentChat}
        bridgeUrl={bridgeUrl}
        bridgeToken={bridgeToken ?? null}
        onOpenLocalPreview={onOpenLocalPreview}
        onOpenSubAgentThread={openAgentDetail}
        showToolCalls={showToolCalls ?? true}
        agentThreadStatusById={agentThreadStatusById}
        scrollRef={scrollRef}
        inlineChoicesEnabled={!pendingUserInputRequest && !pendingApproval && !isLoading}
        onInlineOptionSelect={handleInlineOptionSelect}
        onPinnedAutoScroll={scrollToBottomIfPinned}
        onJumpToLatest={handleJumpToLatest}
        onScrollInteractionStart={clearPendingScrollRetries}
        autoScrollStateRef={autoScrollStateRef}
        bottomInset={bottomInset}
        topInset={topInset}
        liveMessageState={liveMessageState}
        continuationState={transcriptContinuationState}
        onLoadEarlier={handleLoadEarlierPress}
        supportsConversationFork={activeAgentSupports?.threadFork === true}
        supportsForkFromResponse={activeAgentSupports?.threadForkFromResponse === true}
        onForkConversation={forkConversation}
        activity={activity}
      />
    );
  }

  if (isOpeningChat) {
    return <ChatOpeningView topInset={topInset} />;
  }

  return (
    <ComposeView
      startWorkspaceLabel={defaultStartWorkspaceLabel}
      showAgentPicker={readyAgents.length > 1}
      agentLabel={activeAgentLabel}
      showModelControls={modelOptions.length > 0}
      modelLabel={activeModelLabel}
      showThinkingControls={activeModelEffortOptions.length > 0}
      thinkingLabel={activeEffortLabel}
      collaborationModeLabel={collaborationModeLabel}
      showFastMode={supportsFastMode}
      fastModeEnabled={fastModeEnabled}
      fastModeLabel={fastModeLabel}
      keyboardVisible={keyboardVisible}
      bottomInset={bottomInset}
      topInset={topInset}
      onSuggestion={(suggestion) => setDraft(suggestion)}
      onOpenWorkspacePicker={openWorkspaceModal}
      onOpenAgentPicker={openAgentModal}
      onOpenModelPicker={openModelModal}
      onOpenThinkingPicker={() => openEffortModal()}
      onOpenCollaborationModePicker={openCollaborationModeMenu}
      onToggleFastMode={() => {
        void toggleFastMode();
      }}
    />
  );
}

function MainScreenSelectionSheets({
  attachmentMenuVisible,
  attachmentMenuOptions,
  attachmentController,
  agentThreadMenuVisible,
  agentThreadMenuOptions,
  collaborationModeMenuVisible,
  collaborationModeOptions,
  activeAgentLabel,
  agentModalVisible,
  agentPickerOptions,
  closeAgentModal,
  loadingAgentThreads,
  setAgentThreadMenuVisible,
  setCollaborationModeMenuVisible,
}: SelectionSheetsProps) {
  return (
    <>
      <SelectionSheet
        visible={attachmentMenuVisible}
        eyebrow="Attachments"
        title="Add context"
        subtitle="Bring in a workspace path, a file, a saved image, or a fresh photo."
        options={attachmentMenuOptions}
        presentation="expanded"
        onClose={attachmentController.closeMenu}
      />
      <SelectionSheet
        visible={agentThreadMenuVisible}
        eyebrow="Agents"
        title="Agent threads"
        subtitle="Switch between the main thread and spawned sub-agent threads."
        options={agentThreadMenuOptions}
        loading={loadingAgentThreads}
        loadingLabel="Loading agent threads…"
        emptyLabel="No spawned agent threads for this chat yet."
        presentation="expanded"
        onClose={() => setAgentThreadMenuVisible(false)}
      />
      <SelectionSheet
        visible={collaborationModeMenuVisible}
        eyebrow="Agent"
        title="Agent mode"
        subtitle={`Choose a mode supported by ${activeAgentLabel}.`}
        options={collaborationModeOptions}
        onClose={() => setCollaborationModeMenuVisible(false)}
      />
      <SelectionSheet
        visible={agentModalVisible}
        eyebrow="Agent"
        title="Select agent"
        subtitle="Choose which installed ACP agent should start the new chat."
        options={agentPickerOptions}
        onClose={closeAgentModal}
      />
    </>
  );
}

export function MainScreenTranscriptAndSheets({ context }: { context: Context }) {
  const {
    selectedChat,
    isOpeningChat,
    selectedParentChat,
    bridgeUrl,
    bridgeToken,
    onOpenLocalPreview,
    openAgentDetail,
    showToolCalls,
    agentThreadStatusById,
    scrollRef,
    isLoading,
    handleInlineOptionSelect,
    scrollToBottomIfPinned,
    handleJumpToLatest,
    clearPendingScrollRetries,
    autoScrollStateRef,
    composerReservedInset,
    transcriptContinuationState,
    handleLoadEarlier,
    defaultStartWorkspaceLabel,
    readyAgents,
    activeAgentLabel,
    activeAgentSupports,
    modelOptions,
    activeModelLabel,
    activeModelEffortOptions,
    activeEffortLabel,
    collaborationModeLabel,
    supportsFastMode,
    fastModeEnabled,
    fastModeLabel,
    setDraft,
    openWorkspaceModal,
    openAgentModal,
    openModelModal,
    openEffortModal,
    openCollaborationModeMenu,
    toggleFastMode,
    forkConversation,
    shouldShowComposer,
    renderComposer,
    showTranscriptActivity,
    displayedActivity,
    attachmentMenuVisible,
    attachmentMenuOptions,
    attachmentController,
    agentThreadMenuOptions,
    collaborationModeOptions,
    agentPickerOptions,
    closeAgentModal,
  } = context;
  const { styles } = useMainScreenStyles();
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const pendingUserInputRequest = useAtomValue(pendingUserInputRequestAtom);
  const liveAssistantByThread = useAtomValue(liveAssistantByThreadAtom);
  const loadingAgentThreads = useAtomValue(loadingAgentThreadsAtom);
  const keyboardVisible = useAtomValue(keyboardVisibleAtom);
  const topChromeHeight = useAtomValue(topChromeHeightAtom);
  const agentThreadMenuVisible = useAtomValue(agentThreadMenuVisibleAtom);
  const agentModalVisible = useAtomValue(agentModalVisibleAtom);
  const collaborationModeMenuVisible = useAtomValue(collaborationModeMenuVisibleAtom);
  const setAgentThreadMenuVisible = useSetAtom(agentThreadMenuVisibleAtom);
  const setCollaborationModeMenuVisible = useSetAtom(collaborationModeMenuVisibleAtom);
  const usesOverlayComposer = Platform.OS === 'android' || Platform.OS === 'ios';
  const contentBottomInset = usesOverlayComposer ? composerReservedInset : 0;
  const contentProps: BodyContentProps = {
    selectedChat,
    isOpeningChat,
    selectedParentChat,
    bridgeUrl,
    bridgeToken,
    onOpenLocalPreview,
    openAgentDetail,
    showToolCalls,
    agentThreadStatusById,
    scrollRef,
    isLoading,
    pendingApproval,
    pendingUserInputRequest,
    handleInlineOptionSelect,
    scrollToBottomIfPinned,
    handleJumpToLatest,
    clearPendingScrollRetries,
    autoScrollStateRef,
    transcriptContinuationState,
    handleLoadEarlier,
    defaultStartWorkspaceLabel,
    readyAgents,
    activeAgentLabel,
    activeAgentSupports,
    modelOptions,
    activeModelLabel,
    activeModelEffortOptions,
    activeEffortLabel,
    collaborationModeLabel,
    supportsFastMode,
    fastModeEnabled,
    fastModeLabel,
    setDraft,
    openWorkspaceModal,
    openAgentModal,
    openModelModal,
    openEffortModal,
    openCollaborationModeMenu,
    toggleFastMode,
    forkConversation,
    liveMessageState: selectedChat ? (liveAssistantByThread[selectedChat.id] ?? null) : null,
    activity: showTranscriptActivity ? displayedActivity : null,
    keyboardVisible,
    bottomInset: contentBottomInset,
    topInset: topChromeHeight,
  };

  return (
    <>
      <View style={styles.bodyContainer}>
        {/* No KeyboardAvoidingView here on purpose. The overlay composer already floats on the
            measured keyboard inset and `composerReservedInset` feeds that same inset to the
            transcript, so padding this container would push the messages up by a second keyboard
            height and shove short transcripts off screen. Keeping the shell at full height makes
            the keyboard slide the content by exactly one keyboard height, like iMessage. */}
        <View style={styles.bodyShell}>
          <TranscriptOrComposerContent
            {...contentProps}
            keyboardVisible={Platform.OS === 'android' ? keyboardVisible : false}
            bottomInset={contentBottomInset}
          />
          {Platform.OS === 'ios' && shouldShowComposer ? renderComposer(true) : null}
          {!usesOverlayComposer && shouldShowComposer ? renderComposer(false) : null}
        </View>
        {Platform.OS === 'android' && shouldShowComposer ? renderComposer(true) : null}
      </View>
      <MainScreenSelectionSheets
        attachmentMenuVisible={attachmentMenuVisible}
        attachmentMenuOptions={attachmentMenuOptions}
        attachmentController={attachmentController}
        agentThreadMenuVisible={agentThreadMenuVisible}
        agentThreadMenuOptions={agentThreadMenuOptions}
        collaborationModeMenuVisible={collaborationModeMenuVisible}
        collaborationModeOptions={collaborationModeOptions}
        activeAgentLabel={activeAgentLabel}
        agentModalVisible={agentModalVisible}
        agentPickerOptions={agentPickerOptions}
        closeAgentModal={closeAgentModal}
        loadingAgentThreads={loadingAgentThreads}
        setAgentThreadMenuVisible={setAgentThreadMenuVisible}
        setCollaborationModeMenuVisible={setCollaborationModeMenuVisible}
      />
    </>
  );
}
