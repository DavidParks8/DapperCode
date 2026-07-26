import {
  keyboardVisibleAtom,
  planPanelCollapsedByThreadAtom,
} from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { shouldCollapseWorkflowCardForKeyboard } from './planCardState';
import type {
  MainScreenPlanExecutionActionsContext,
  MainScreenPlanExecutionActionsResult,
} from './mainScreenPlanExecutionActions';

export type MainScreenPanelCollapseCoordinatorContext = MainScreenPlanExecutionActionsContext &
  MainScreenPlanExecutionActionsResult;

export function useMainScreenPanelCollapseCoordinator(
  context: MainScreenPanelCollapseCoordinatorContext,
) {
  const { planPanelCollapsed, selectedChat, workflowCardMode } = context;
  const keyboardVisible = useAtomValue(keyboardVisibleAtom);
  const setPlanPanelCollapsedByThread = useSetAtom(planPanelCollapsedByThreadAtom);

  useEffect(() => {
    const threadId = selectedChat?.id;
    if (
      !threadId ||
      !shouldCollapseWorkflowCardForKeyboard({
        collapsed: planPanelCollapsed,
        keyboardVisible,
        mode: workflowCardMode,
        threadId,
      })
    ) {
      return;
    }

    setPlanPanelCollapsedByThread((prev) => {
      if (prev[threadId] === true) {
        return prev;
      }
      return {
        ...prev,
        [threadId]: true,
      };
    });
  }, [keyboardVisible, planPanelCollapsed, selectedChat?.id, workflowCardMode]);

  const toggleSelectedPlanPanel = useCallback(() => {
    if (!selectedChat?.id || workflowCardMode === null) {
      return;
    }

    setPlanPanelCollapsedByThread((prev) => ({
      ...prev,
      [selectedChat.id]: !(prev[selectedChat.id] ?? false),
    }));
  }, [selectedChat?.id, workflowCardMode]);

  return {
    toggleSelectedPlanPanel,
  };
}

export type MainScreenPanelCollapseCoordinatorResult = ReturnType<
  typeof useMainScreenPanelCollapseCoordinator
>;
