import { useStore } from 'jotai';
import { useRef } from 'react';
import type { Chat } from '@bridge/types/types';
import { resetMainScreenStateAtom } from '../state/registry';
import { useMainScreenBaseContext } from './useBaseContext';
import { useMainScreenCoreBootstrap } from '../session/coreBootstrap';
import { useMainScreenLifecycleRecovery } from '../session/lifecycleRecovery';
import { useMainScreenChatSessionState } from '../session/sessionState';
import { useMainScreenLocalTranscriptActions } from '../transcript/localTranscriptActions';
import { useMainScreenThreadSnapshotStore } from '../session/threadSnapshotStore';
import { useMainScreenChatHydration } from '../session/hydration';
import { useMainScreenRuntimeWatchdogSync } from '../turn/runtimeWatchdogSync';
import { useMainScreenThreadRuntimeMutations } from '../turn/threadRuntimeMutations';
import { useMainScreenSelectedRuntimeSelectors } from '../state/selectedRuntimeSelectors';
import { useMainScreenModelCatalogState } from '../models/catalogState';
import { useMainScreenCapabilityFlags } from '../turn/capabilityFlags';
import { useMainScreenWorkspaceBrowserState } from '../session/workspaceBrowserState';
import { useMainScreenAgentThreadsRefresh } from '../agents/threadsRefresh';
import { useMainScreenWorkspaceCheckoutActions } from '../session/workspaceCheckoutActions';
import { useMainScreenModeConfigurationSession } from '../models/modeConfigurationSession';
import { useMainScreenComposerControlActions } from '../composer/controlActions';
import { useMainScreenPickerOptionBuilders } from '../models/pickerOptionBuilders';
import { useMainScreenLocalCommandChat } from '../session/localCommandChat';
import { useMainScreenReasoningAndInterrupt } from '../turn/reasoningAndInterrupt';
import { useMainScreenTurnStopControl } from '../turn/stopControl';
import { useMainScreenSlashCommandHandler } from '../composer/slashCommandHandler';
import { useMainScreenChatLoadPipeline } from '../session/loadPipeline';
import { useMainScreenChatNavigation } from '../session/chatNavigation';
import { useMainScreenAgentThreadSelectorState } from '../agents/threadSelectorState';
import { useMainScreenAgentThreadEventBootstrap } from '../agents/threadEventBootstrap';
import { useMainScreenChatCreationFlow } from '../session/chatCreationFlow';
import { useMainScreenSendMessageHandler } from '../turn/sendMessageHandler';
import { useMainScreenComposerSubmitActions } from '../composer/submitActions';
import { useMainScreenReplayRecoveryEngine } from '../turn/replayRecoveryEngine';
import { useMainScreenWsEventRouter } from '../turn/wsEventRouter';
import { useMainScreenApprovalAndUserInputResolution } from '../approvals/userInputResolution';
import { useMainScreenUiActionHandlers } from './uiActionHandlers';
import { useMainScreenHeaderActivityViewModel } from './headerActivityViewModel';
import { useMainScreenWorkflowQueueState } from '../workflow/queueState';
import { useMainScreenComposerRenderer } from '../composer/renderer';
import { useMainScreenPlanExecutionActions } from '../plan/executionActions';
import { useMainScreenPanelCollapseCoordinator } from './panelCollapseCoordinator';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';
import { MainScreenView } from './View';

export interface MainScreenHandle {
  openChat: (id: string, optimisticChat?: Chat | null) => void;
  startNewChat: () => void;
}

export function MainScreen() {
  const store = useStore();
  // MainScreen state lives in atoms that outlive this component, so a fresh mount (a new bridge
  // profile) has to clear it before any child reads it. A ref guard rather than useMemo: React
  // may discard a memo cache and recompute it later, which would wipe live state mid-session.
  const didResetRef = useRef(false);
  if (!didResetRef.current) {
    didResetRef.current = true;
    store.set(resetMainScreenStateAtom);
  }
  const mainScreenBaseContext = useMainScreenBaseContext();
  const coreBootstrapResult = useMainScreenCoreBootstrap(mainScreenBaseContext);
  const coreBootstrapContext = { ...mainScreenBaseContext, ...coreBootstrapResult };
  const lifecycleRecoveryResult = useMainScreenLifecycleRecovery(coreBootstrapContext);
  const lifecycleRecoveryContext = { ...coreBootstrapContext, ...lifecycleRecoveryResult };
  const chatSessionStateResult = useMainScreenChatSessionState(lifecycleRecoveryContext);
  const chatSessionStateContext = { ...lifecycleRecoveryContext, ...chatSessionStateResult };
  const localTranscriptActionsResult = useMainScreenLocalTranscriptActions(chatSessionStateContext);
  const localTranscriptActionsContext = {
    ...chatSessionStateContext,
    ...localTranscriptActionsResult,
  };
  const threadSnapshotStoreResult = useMainScreenThreadSnapshotStore(localTranscriptActionsContext);
  const threadSnapshotStoreContext = {
    ...localTranscriptActionsContext,
    ...threadSnapshotStoreResult,
  };
  const chatHydrationResult = useMainScreenChatHydration(threadSnapshotStoreContext);
  const chatHydrationContext = { ...threadSnapshotStoreContext, ...chatHydrationResult };
  const runtimeWatchdogSyncResult = useMainScreenRuntimeWatchdogSync(chatHydrationContext);
  const runtimeWatchdogSyncContext = { ...chatHydrationContext, ...runtimeWatchdogSyncResult };
  const threadRuntimeMutationsResult = useMainScreenThreadRuntimeMutations(
    runtimeWatchdogSyncContext,
  );
  const threadRuntimeMutationsContext = {
    ...runtimeWatchdogSyncContext,
    ...threadRuntimeMutationsResult,
  };
  const selectedRuntimeSelectorsResult = useMainScreenSelectedRuntimeSelectors(
    threadRuntimeMutationsContext,
  );
  const selectedRuntimeSelectorsContext = {
    ...threadRuntimeMutationsContext,
    ...selectedRuntimeSelectorsResult,
  };
  const modelCatalogStateResult = useMainScreenModelCatalogState(selectedRuntimeSelectorsContext);
  const modelCatalogStateContext = {
    ...selectedRuntimeSelectorsContext,
    ...modelCatalogStateResult,
  };
  const capabilityFlagsResult = useMainScreenCapabilityFlags(modelCatalogStateContext);
  const capabilityFlagsContext = { ...modelCatalogStateContext, ...capabilityFlagsResult };
  const workspaceBrowserStateResult = useMainScreenWorkspaceBrowserState();
  const workspaceBrowserStateContext = {
    ...capabilityFlagsContext,
    ...workspaceBrowserStateResult,
  };
  const agentThreadsRefreshResult = useMainScreenAgentThreadsRefresh(workspaceBrowserStateContext);
  const agentThreadsRefreshContext = {
    ...workspaceBrowserStateContext,
    ...agentThreadsRefreshResult,
  };
  const workspaceCheckoutActionsResult = useMainScreenWorkspaceCheckoutActions(
    agentThreadsRefreshContext,
  );
  const workspaceCheckoutActionsContext = {
    ...agentThreadsRefreshContext,
    ...workspaceCheckoutActionsResult,
  };
  const modeConfigurationSessionResult = useMainScreenModeConfigurationSession(
    workspaceCheckoutActionsContext,
  );
  const modeConfigurationSessionContext = {
    ...workspaceCheckoutActionsContext,
    ...modeConfigurationSessionResult,
  };
  const composerControlActionsResult = useMainScreenComposerControlActions(
    modeConfigurationSessionContext,
  );
  const composerControlActionsContext = {
    ...modeConfigurationSessionContext,
    ...composerControlActionsResult,
  };
  const pickerOptionBuildersResult = useMainScreenPickerOptionBuilders(
    composerControlActionsContext,
  );
  const pickerOptionBuildersContext = {
    ...composerControlActionsContext,
    ...pickerOptionBuildersResult,
  };
  const localCommandChatResult = useMainScreenLocalCommandChat(pickerOptionBuildersContext);
  const localCommandChatContext = { ...pickerOptionBuildersContext, ...localCommandChatResult };
  const reasoningAndInterruptResult = useMainScreenReasoningAndInterrupt(localCommandChatContext);
  const reasoningAndInterruptContext = {
    ...localCommandChatContext,
    ...reasoningAndInterruptResult,
  };
  const turnStopControlResult = useMainScreenTurnStopControl(reasoningAndInterruptContext);
  const turnStopControlContext = { ...reasoningAndInterruptContext, ...turnStopControlResult };
  const slashCommandHandlerResult = useMainScreenSlashCommandHandler(turnStopControlContext);
  const slashCommandHandlerContext = { ...turnStopControlContext, ...slashCommandHandlerResult };
  const chatLoadPipelineResult = useMainScreenChatLoadPipeline(slashCommandHandlerContext);
  const chatLoadPipelineContext = { ...slashCommandHandlerContext, ...chatLoadPipelineResult };
  const chatNavigationResult = useMainScreenChatNavigation(chatLoadPipelineContext);
  const chatNavigationContext = {
    ...chatLoadPipelineContext,
    ...chatNavigationResult,
  };
  const agentThreadSelectorStateResult =
    useMainScreenAgentThreadSelectorState(chatNavigationContext);
  const agentThreadSelectorStateContext = {
    ...chatNavigationContext,
    ...agentThreadSelectorStateResult,
  };
  const agentThreadEventBootstrapResult = useMainScreenAgentThreadEventBootstrap(
    agentThreadSelectorStateContext,
  );
  const agentThreadEventBootstrapContext = {
    ...agentThreadSelectorStateContext,
    ...agentThreadEventBootstrapResult,
  };
  const chatCreationFlowResult = useMainScreenChatCreationFlow(agentThreadEventBootstrapContext);
  const chatCreationFlowContext = {
    ...agentThreadEventBootstrapContext,
    ...chatCreationFlowResult,
  };
  const sendMessageHandlerResult = useMainScreenSendMessageHandler(chatCreationFlowContext);
  const sendMessageHandlerContext = { ...chatCreationFlowContext, ...sendMessageHandlerResult };
  const composerSubmitActionsResult = useMainScreenComposerSubmitActions(sendMessageHandlerContext);
  const composerSubmitActionsContext = {
    ...sendMessageHandlerContext,
    ...composerSubmitActionsResult,
  };
  const replayRecoveryEngineResult = useMainScreenReplayRecoveryEngine(
    composerSubmitActionsContext,
  );
  const replayRecoveryEngineContext = {
    ...composerSubmitActionsContext,
    ...replayRecoveryEngineResult,
  };
  const wsEventRouterResult = useMainScreenWsEventRouter(replayRecoveryEngineContext);
  const wsEventRouterContext = { ...replayRecoveryEngineContext, ...wsEventRouterResult };
  const approvalAndUserInputResolutionResult =
    useMainScreenApprovalAndUserInputResolution(wsEventRouterContext);
  const approvalAndUserInputResolutionContext = {
    ...wsEventRouterContext,
    ...approvalAndUserInputResolutionResult,
  };
  const uiActionHandlersResult = useMainScreenUiActionHandlers(
    approvalAndUserInputResolutionContext,
  );
  const uiActionHandlersContext = {
    ...approvalAndUserInputResolutionContext,
    ...uiActionHandlersResult,
  };
  const headerActivityViewModelResult =
    useMainScreenHeaderActivityViewModel(uiActionHandlersContext);
  const headerActivityViewModelContext = {
    ...uiActionHandlersContext,
    ...headerActivityViewModelResult,
  };
  const workflowQueueStateResult = useMainScreenWorkflowQueueState(headerActivityViewModelContext);
  const workflowQueueStateContext = {
    ...headerActivityViewModelContext,
    ...workflowQueueStateResult,
  };
  const composerRendererResult = useMainScreenComposerRenderer(workflowQueueStateContext);
  const composerRendererContext = { ...workflowQueueStateContext, ...composerRendererResult };
  const planExecutionActionsResult = useMainScreenPlanExecutionActions(composerRendererContext);
  const planExecutionActionsContext = { ...composerRendererContext, ...planExecutionActionsResult };
  const panelCollapseCoordinatorResult = useMainScreenPanelCollapseCoordinator(
    planExecutionActionsContext,
  );
  const panelCollapseCoordinatorContext = {
    ...planExecutionActionsContext,
    ...panelCollapseCoordinatorResult,
  };
  const mainScreenContext =
    panelCollapseCoordinatorContext as MainScreenPanelCollapseCoordinatorContext &
      MainScreenPanelCollapseCoordinatorResult;
  return <MainScreenView context={mainScreenContext} />;
}
