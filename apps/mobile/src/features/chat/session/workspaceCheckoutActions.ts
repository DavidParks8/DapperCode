import { useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';

import { bridgeRecoveryBannerVisibleAtom } from '../state/composer';
import { errorAtom } from '../state/turn';
import {
  changeGitCheckoutDirectoryNameAtom,
  changeGitCheckoutRepoUrlAtom,
  selectWorkspaceAtom,
  submitGitCheckoutAtom,
} from '../../workspace/state/workspaceActions';
import { scheduleIdleTask, isBridgeConnectionErrorMessage } from '../helpers/helpers';
import type {
  MainScreenAgentThreadsRefreshContext,
  MainScreenAgentThreadsRefreshResult,
} from '../agents/threadsRefresh';

export type MainScreenWorkspaceCheckoutActionsContext = MainScreenAgentThreadsRefreshContext &
  MainScreenAgentThreadsRefreshResult;

export function useMainScreenWorkspaceCheckoutActions(
  context: MainScreenWorkspaceCheckoutActionsContext,
) {
  const {
    appStateRef,
    chatIdRef,
    clearDeferredDisconnectActivity,
    clearForegroundAgentRefresh,
    foregroundAgentRefreshHandleRef,
    lastAppForegroundedAtRef,
    scheduleAgentThreadsRefresh,
    scheduleDisconnectActivity,
    ws,
  } = context;
  const setError = useSetAtom(errorAtom);
  const setBridgeRecoveryBannerVisible = useSetAtom(bridgeRecoveryBannerVisibleAtom);

  useEffect(() => {
    if (appStateRef.current === 'active' && !ws.isConnected) {
      scheduleDisconnectActivity();
    }

    return ws.onStatus((connected) => {
      if (connected) {
        clearDeferredDisconnectActivity();
        setBridgeRecoveryBannerVisible(false);
        setError((previous) => (isBridgeConnectionErrorMessage(previous) ? null : previous));
        return;
      }

      if (appStateRef.current !== 'active') {
        clearDeferredDisconnectActivity();
        setBridgeRecoveryBannerVisible(false);
        return;
      }

      scheduleDisconnectActivity();
    });
  }, [
    appStateRef,
    clearDeferredDisconnectActivity,
    scheduleDisconnectActivity,
    setBridgeRecoveryBannerVisible,
    setError,
    ws,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const previousAppState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (nextAppState !== 'active') {
        clearDeferredDisconnectActivity();
        clearForegroundAgentRefresh();
        setBridgeRecoveryBannerVisible(false);
        return;
      }

      if (previousAppState === 'active') {
        return;
      }

      lastAppForegroundedAtRef.current = Date.now();
      clearDeferredDisconnectActivity();
      if (!ws.isConnected) {
        scheduleDisconnectActivity();
      }

      const activeChatId = chatIdRef.current;
      if (!activeChatId) {
        return;
      }

      clearForegroundAgentRefresh();
      foregroundAgentRefreshHandleRef.current = scheduleIdleTask(() => {
        foregroundAgentRefreshHandleRef.current = null;
        if (appStateRef.current !== 'active' || chatIdRef.current !== activeChatId) {
          return;
        }
        scheduleAgentThreadsRefresh(activeChatId);
      });
    });

    return () => {
      clearForegroundAgentRefresh();
      subscription.remove();
    };
  }, [
    appStateRef,
    chatIdRef,
    clearDeferredDisconnectActivity,
    clearForegroundAgentRefresh,
    foregroundAgentRefreshHandleRef,
    lastAppForegroundedAtRef,
    scheduleAgentThreadsRefresh,
    scheduleDisconnectActivity,
    setBridgeRecoveryBannerVisible,
    ws,
  ]);

  const selectWorkspace = useSetAtom(selectWorkspaceAtom);
  const changeRepoUrl = useSetAtom(changeGitCheckoutRepoUrlAtom);
  const changeDirectoryName = useSetAtom(changeGitCheckoutDirectoryNameAtom);
  const submitCheckout = useSetAtom(submitGitCheckoutAtom);

  const handleWorkspaceSelection = useCallback(
    (cwd: string | null) => {
      selectWorkspace(cwd);
    },
    [selectWorkspace],
  );

  const handleGitCheckoutRepoUrlChange = useCallback(
    (value: string) => {
      changeRepoUrl(value);
    },
    [changeRepoUrl],
  );

  const handleGitCheckoutDirectoryNameChange = useCallback(
    (value: string) => {
      changeDirectoryName(value);
    },
    [changeDirectoryName],
  );

  const submitGitCheckout = useCallback(async () => {
    await submitCheckout();
  }, [submitCheckout]);

  return {
    handleWorkspaceSelection,
    handleGitCheckoutRepoUrlChange,
    handleGitCheckoutDirectoryNameChange,
    submitGitCheckout,
  };
}

export type MainScreenWorkspaceCheckoutActionsResult = ReturnType<
  typeof useMainScreenWorkspaceCheckoutActions
>;
