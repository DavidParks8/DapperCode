import { MainScreenHeaderAndWorkflow } from './HeaderAndWorkflow';
import { MainScreenTranscriptAndSheets } from '../transcript/TranscriptAndSheets';
import { MainScreenRenameSheet } from './RenameSheet';
import { MainScreenAttachmentModals } from '../composer/AttachmentModals';
import { MainScreenApprovalAndBridgePrompts } from '../approvals/BridgePrompts';
import { MainScreenModelAndEffortSheets } from '../models/ModelAndEffortSheets';
import { ResponseUsageOverlay } from '../message/ResponseUsageOverlay';
import { memo, useCallback, type ComponentType } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useSetAtom } from 'jotai';
import { useMainScreenStyles } from '../styles/useStyles';
import { topChromeHeightAtom } from '../state/composer';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

type MainScreenViewContext = MainScreenPanelCollapseCoordinatorContext &
  MainScreenPanelCollapseCoordinatorResult;

type MainScreenSurfaceProps = { context: MainScreenViewContext };
type MainScreenContextKey = keyof MainScreenViewContext;

function memoizeContextSurface(
  Component: ComponentType<MainScreenSurfaceProps>,
  contextKeys: readonly MainScreenContextKey[],
) {
  return memo(Component, (previous, next) =>
    contextKeys.every((key) => Object.is(previous.context[key], next.context[key])),
  );
}

const headerContextKeys = [
  'onOpenDrawer',
  'headerTitle',
  'activeAgent',
  'openTitleEditor',
  'handleOpenGit',
  'isOpeningChat',
  'showTopCardsRow',
  'modelOptions',
  'openModelModal',
  'activeModelLabel',
  'activeModelEffortOptions',
  'openEffortModal',
  'activeEffortLabel',
  'openCollaborationModeMenu',
  'collaborationModeLabel',
  'showAgentThreadChip',
  'openAgentThreadSelector',
  'agentThreadChipLabel',
  'supportsFastMode',
  'fastModeEnabled',
  'fastModeControlDisabled',
  'toggleFastMode',
  'workflowBridgeUiSurfaces',
  'windowHeight',
  'handleBridgeUiAction',
  'dismissBridgeUiSurface',
  'workflowCardMode',
  'selectedThreadPlan',
  'planPanelCollapsed',
  'toggleSelectedPlanPanel',
  'implementPlan',
  'stayInPlanMode',
] as const satisfies readonly MainScreenContextKey[];

const StableHeaderAndWorkflow = memo(
  MainScreenHeaderAndWorkflow,
  (previous, next) =>
    headerContextKeys.every((key) => Object.is(previous.context[key], next.context[key])) &&
    Boolean(previous.context.selectedChat) === Boolean(next.context.selectedChat) &&
    Object.is(
      previous.context.selectedThreadRuntimeSnapshot?.tokenTotals ??
        previous.context.selectedChat?.tokenTotals,
      next.context.selectedThreadRuntimeSnapshot?.tokenTotals ??
        next.context.selectedChat?.tokenTotals,
    ) &&
    Object.is(
      previous.context.selectedChat?.acpUsage?.cost,
      next.context.selectedChat?.acpUsage?.cost,
    ),
);

const StableTranscriptAndSheets = memoizeContextSurface(MainScreenTranscriptAndSheets, [
  'selectedChat',
  'isOpeningChat',
  'selectedParentChat',
  'bridgeUrl',
  'bridgeToken',
  'onOpenLocalPreview',
  'openAgentDetail',
  'showToolCalls',
  'agentThreadStatusById',
  'scrollRef',
  'isLoading',
  'handleInlineOptionSelect',
  'scrollToBottomIfPinned',
  'handleJumpToLatest',
  'clearPendingScrollRetries',
  'autoScrollStateRef',
  'composerReservedInset',
  'transcriptContinuationState',
  'handleLoadEarlier',
  'defaultStartWorkspaceLabel',
  'readyAgents',
  'activeAgentLabel',
  'activeAgentSupports',
  'modelOptions',
  'activeModelLabel',
  'activeModelEffortOptions',
  'activeEffortLabel',
  'collaborationModeLabel',
  'supportsFastMode',
  'fastModeEnabled',
  'fastModeLabel',
  'setDraft',
  'openWorkspaceModal',
  'openAgentModal',
  'openModelModal',
  'openEffortModal',
  'openCollaborationModeMenu',
  'toggleFastMode',
  'forkConversation',
  'shouldShowComposer',
  'renderComposer',
  'showTranscriptActivity',
  'displayedActivity',
  'attachmentMenuVisible',
  'attachmentMenuOptions',
  'attachmentController',
  'agentThreadMenuOptions',
  'collaborationModeOptions',
  'agentPickerOptions',
  'closeAgentModal',
]);

const StableModelAndEffortSheets = memoizeContextSurface(MainScreenModelAndEffortSheets, [
  'activeModelLabel',
  'closeEffortModal',
  'closeModelModal',
  'effortPickerSheetOptions',
  'modelPickerOptions',
]);

const StableRenameSheet = memoizeContextSurface(MainScreenRenameSheet, [
  'closeTitleEditor',
  'saveTitle',
]);

const StableAttachmentModals = memoizeContextSurface(MainScreenAttachmentModals, [
  'attachmentModalVisible',
  'closeAttachmentModal',
  'attachmentPathDraft',
  'setAttachmentPathDraft',
  'isLoading',
  'submitAttachmentPath',
  'pendingMentionPaths',
  'removePendingMentionPath',
]);

const StableApprovalAndBridgePrompts = memoizeContextSurface(MainScreenApprovalAndBridgePrompts, [
  'setUserInputDraft',
  'dismissUserInputRequest',
  'submitUserInputRequest',
  'modalBridgeUiSurface',
  'handleBridgeUiAction',
  'dismissBridgeUiSurface',
]);

export function MainScreenView({ context }: { context: MainScreenViewContext }) {
  const { styles } = useMainScreenStyles();
  const setTopChromeHeight = useSetAtom(topChromeHeightAtom);
  const handleTopChromeLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = Math.ceil(event.nativeEvent.layout.height);
      setTopChromeHeight((current) => (current === nextHeight ? current : nextHeight));
    },
    [setTopChromeHeight],
  );

  return (
    <View style={styles.container}>
      <View
        onLayout={handleTopChromeLayout}
        style={styles.topChromeOverlay}
        testID="main-screen-top-chrome"
      >
        <StableHeaderAndWorkflow context={context} />
      </View>
      <StableTranscriptAndSheets context={context} />
      <StableModelAndEffortSheets context={context} />
      <StableRenameSheet context={context} />
      <StableAttachmentModals context={context} />
      <StableApprovalAndBridgePrompts context={context} />
      {/* Last so the panel a transcript row anchors covers the header and composer too. */}
      <ResponseUsageOverlay />
    </View>
  );
}
