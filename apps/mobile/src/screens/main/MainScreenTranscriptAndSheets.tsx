import { useMainScreenStyles } from './useMainScreenStyles';
import {
  liveAssistantByThreadAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
} from '../../state/mainScreen/turn';
import { loadingAgentThreadsAtom } from '../../state/mainScreen/workspace';
import { keyboardVisibleAtom } from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { ActivityBar } from '../../components/ActivityBar';
import { SelectionSheet } from '../../components/SelectionSheet';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';
import { ComposeView } from './MainScreenPresentation';
import { ChatOpeningView } from './MainScreenPresentation';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './mainScreenPanelCollapseCoordinator';
import {
  agentModalVisibleAtom,
  agentThreadMenuVisibleAtom,
  collaborationModeMenuVisibleAtom,
} from '../../state/mainScreen/modals';

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
> & {
  pendingApproval: unknown;
  pendingUserInputRequest: unknown;
  liveMessageState: ChatTranscriptViewProps['liveMessageState'];
  keyboardVisible: boolean;
  bottomInset: number;
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
  liveMessageState,
  transcriptContinuationState,
  handleLoadEarlier,
  defaultStartWorkspaceLabel,
  readyAgents,
  activeAgentLabel,
  modelOptions,
  activeModelLabel,
  activeModelEffortOptions,
  activeEffortLabel,
  collaborationModeLabel,
  supportsFastMode,
  fastModeEnabled,
  fastModeLabel,
  keyboardVisible,
  setDraft,
  openWorkspaceModal,
  openAgentModal,
  openModelModal,
  openEffortModal,
  openCollaborationModeMenu,
  toggleFastMode,
}: BodyContentProps) {
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
        liveMessageState={liveMessageState}
        continuationState={transcriptContinuationState}
        onLoadEarlier={() => {
          void handleLoadEarlier();
        }}
      />
    );
  }

  if (isOpeningChat) {
    return <ChatOpeningView />;
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
    androidComposerReservedInset,
    transcriptContinuationState,
    handleLoadEarlier,
    defaultStartWorkspaceLabel,
    readyAgents,
    activeAgentLabel,
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
    shouldShowComposer,
    renderComposer,
    chatBottomInset,
    showFloatingActivity,
    displayedActivity,
    activityDetail,
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
  const agentThreadMenuVisible = useAtomValue(agentThreadMenuVisibleAtom);
  const agentModalVisible = useAtomValue(agentModalVisibleAtom);
  const collaborationModeMenuVisible = useAtomValue(collaborationModeMenuVisibleAtom);
  const setAgentThreadMenuVisible = useSetAtom(agentThreadMenuVisibleAtom);
  const setCollaborationModeMenuVisible = useSetAtom(collaborationModeMenuVisibleAtom);
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
    liveMessageState: selectedChat ? (liveAssistantByThread[selectedChat.id] ?? null) : null,
    keyboardVisible,
    bottomInset: chatBottomInset,
  };

  return (
    <>
      {Platform.OS === 'android' ? (
        <View style={styles.bodyContainer}>
          <KeyboardAvoidingView style={styles.keyboardAvoiding} enabled={false}>
            <TranscriptOrComposerContent
              {...contentProps}
              keyboardVisible={keyboardVisible}
              bottomInset={androidComposerReservedInset}
            />
          </KeyboardAvoidingView>

          {shouldShowComposer ? renderComposer(true) : null}
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.keyboardAvoiding}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          enabled={Platform.OS === 'ios'}
        >
          <TranscriptOrComposerContent {...contentProps} keyboardVisible={false} bottomInset={0} />

          {showFloatingActivity ? (
            <View pointerEvents="none" style={styles.activityDock}>
              <ActivityBar
                title={displayedActivity.title}
                detail={activityDetail}
                tone={displayedActivity.tone}
              />
            </View>
          ) : null}

          {shouldShowComposer ? renderComposer(false) : null}
        </KeyboardAvoidingView>
      )}
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
