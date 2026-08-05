import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useGlobalSearchParams, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type {
  AgentDefaultSettingsMap,
  AgentId,
  ApprovalMode,
  Chat,
  CollaborationMode,
} from '@bridge/types/types';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import type { AppStore } from '@shell/state/types';
import {
  agentSettingsAtom,
  approvalModeAtom,
  defaultStartCwdAtom,
  preferredAgentIdAtom,
  rememberThreadSettingsAtom,
  showToolCallsAtom,
} from '@shell/state/appState/settings';
import { activeBridgeProfileAtom, bridgeTokenAtom, bridgeUrlAtom } from '@shell/state/bridge/atoms';
import { useBridgeApi, useBridgeWs } from '@shell/state/bridge/hooks';
import {
  mainOpeningChatIdAtom,
  newChatRoutePendingAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from '@shell/state/chat/atoms';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import {
  chatContextChangedAtom,
  openBrowserAtom,
  openChatGitAtom,
} from '@shell/navigation/actions';
import { routes } from '@shell/navigation/routes';

export interface MainScreenBaseContext {
  /** Lets non-React helpers read and write MainScreen atoms. */
  store: AppStore;
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  bridgeUrl: string;
  bridgeToken: string | null;
  bridgeProfileId: string;
  onOpenDrawer?: () => void;
  onOpenGit: (chat: Chat) => void;
  onOpenLocalPreview: (targetUrl: string) => void;
  onOpenBridgeRecoveryGuide: () => void;
  defaultStartCwd: string | null;
  preferredAgentId: AgentId | null;
  agentSettings: AgentDefaultSettingsMap;
  approvalMode: ApprovalMode;
  showToolCalls: boolean;
  onDefaultStartCwdChange: (cwd: string | null) => void;
  onLastUsedThreadSettingsChange: (agentId: AgentId, collaborationMode: CollaborationMode) => void;
  onChatContextChange: (chat: Chat | null) => void;
  onChatOpeningStateChange: (chatId: string | null) => void;
  pendingOpenChatId: string | null;
  pendingOpenChatSnapshot: Chat | null;
  onPendingOpenChatHandled: () => void;
  agentDetailThreadId: string | null;
}

/** Resolves everything MainScreen used to receive through props from the app-state atoms. */
export function useMainScreenBaseContext(): MainScreenBaseContext {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{
    chatId?: string;
    profileId?: string;
  }>();
  const { threadId } = useGlobalSearchParams<{ threadId?: string }>();
  const api = useBridgeApi();
  const ws = useBridgeWs();
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  const pendingOpenChatId = useAtomValue(pendingMainChatIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const newChatRoutePending = useAtomValue(newChatRoutePendingAtom);
  const setPendingChatId = useSetAtom(pendingMainChatIdAtom);
  const setPendingChatSnapshot = useSetAtom(pendingMainChatSnapshotAtom);
  const setNewChatRoutePending = useSetAtom(newChatRoutePendingAtom);

  const onOpenDrawer = drawerCommands?.toggleNavigation;

  const onPendingOpenChatHandled = useCallback(() => {
    setPendingChatId(null);
    setPendingChatSnapshot(null);
  }, [setPendingChatId, setPendingChatSnapshot]);

  const onOpenBridgeRecoveryGuide = useCallback(() => {
    const profileId = routeParams.profileId;
    if (profileId) {
      router.push(routes.connection(profileId, routeParams.chatId ?? 'new', 'reconnect'), {
        withAnchor: true,
      });
    }
  }, [routeParams.chatId, routeParams.profileId, router]);

  const routeChatId =
    routeParams.chatId && routeParams.chatId !== 'new' ? routeParams.chatId : null;
  const resolvedPendingOpenChatId = newChatRoutePending
    ? null
    : routeChatId && routeChatId !== selectedChatId
      ? routeChatId
      : pendingOpenChatId;

  useEffect(() => {
    if (routeParams.chatId === 'new' && newChatRoutePending) {
      setNewChatRoutePending(false);
    }
  }, [newChatRoutePending, routeParams.chatId, setNewChatRoutePending]);

  return {
    store: useStore(),
    api,
    ws,
    bridgeUrl: useAtomValue(bridgeUrlAtom) ?? '',
    bridgeToken: useAtomValue(bridgeTokenAtom),
    bridgeProfileId: useAtomValue(activeBridgeProfileAtom)?.id ?? '',
    onOpenDrawer,
    onOpenGit: useSetAtom(openChatGitAtom),
    onOpenLocalPreview: useSetAtom(openBrowserAtom),
    onOpenBridgeRecoveryGuide,
    defaultStartCwd: useAtomValue(defaultStartCwdAtom),
    preferredAgentId: useAtomValue(preferredAgentIdAtom),
    agentSettings: useAtomValue(agentSettingsAtom),
    approvalMode: useAtomValue(approvalModeAtom),
    showToolCalls: useAtomValue(showToolCallsAtom),
    onDefaultStartCwdChange: useSetAtom(defaultStartCwdAtom),
    onLastUsedThreadSettingsChange: useSetAtom(rememberThreadSettingsAtom),
    onChatContextChange: useSetAtom(chatContextChangedAtom),
    onChatOpeningStateChange: useSetAtom(mainOpeningChatIdAtom),
    pendingOpenChatId: resolvedPendingOpenChatId,
    pendingOpenChatSnapshot: useAtomValue(pendingMainChatSnapshotAtom),
    onPendingOpenChatHandled,
    agentDetailThreadId: threadId ?? null,
  };
}
