import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';

import type { HostBridgeApiClient } from '../api/client';
import type {
  AgentDefaultSettingsMap,
  AgentId,
  ApprovalMode,
  Chat,
  CollaborationMode,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import {
  agentSettingsAtom,
  approvalModeAtom,
  defaultStartCwdAtom,
  preferredAgentIdAtom,
  rememberThreadSettingsAtom,
  showToolCallsAtom,
} from '../state/appState/settings';
import { openBridgeRecoveryGuideAtom } from '../state/bridge/actions';
import {
  activeBridgeProfileAtom,
  bridgeTokenAtom,
  bridgeUrlAtom,
} from '../state/bridge/atoms';
import { useBridgeApi, useBridgeWs } from '../state/bridge/hooks';
import {
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
} from '../state/chat/atoms';
import { drawerCommandsAtom } from '../state/drawer/atoms';
import {
  chatContextChangedAtom,
  openBrowserAtom,
  openChatGitAtom,
} from '../state/navigation/actions';

export interface MainScreenBaseContext {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  bridgeUrl: string;
  bridgeToken: string | null;
  bridgeProfileId: string;
  onOpenDrawer: () => void;
  onOpenGit: (chat: Chat) => void;
  onOpenLocalPreview: (targetUrl: string) => void;
  onOpenBridgeRecoveryGuide: () => void;
  defaultStartCwd: string | null;
  preferredAgentId: AgentId | null;
  agentSettings: AgentDefaultSettingsMap;
  approvalMode: ApprovalMode;
  showToolCalls: boolean;
  onDefaultStartCwdChange: (cwd: string | null) => void;
  onLastUsedThreadSettingsChange: (
    agentId: AgentId,
    collaborationMode: CollaborationMode
  ) => void;
  onChatContextChange: (chat: Chat | null) => void;
  onChatOpeningStateChange: (chatId: string | null) => void;
  pendingOpenChatId: string | null;
  pendingOpenChatSnapshot: Chat | null;
  onPendingOpenChatHandled: () => void;
}

/** Resolves everything MainScreen used to receive through props from the app-state atoms. */
export function useMainScreenBaseContext(): MainScreenBaseContext {
  const api = useBridgeApi();
  const ws = useBridgeWs();
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  const setPendingChatId = useSetAtom(pendingMainChatIdAtom);
  const setPendingChatSnapshot = useSetAtom(pendingMainChatSnapshotAtom);

  const onOpenDrawer = useCallback(() => {
    drawerCommands?.toggleNavigation();
  }, [drawerCommands]);

  const onPendingOpenChatHandled = useCallback(() => {
    setPendingChatId(null);
    setPendingChatSnapshot(null);
  }, [setPendingChatId, setPendingChatSnapshot]);

  return {
    api,
    ws,
    bridgeUrl: useAtomValue(bridgeUrlAtom) ?? '',
    bridgeToken: useAtomValue(bridgeTokenAtom),
    bridgeProfileId: useAtomValue(activeBridgeProfileAtom)?.id ?? '',
    onOpenDrawer,
    onOpenGit: useSetAtom(openChatGitAtom),
    onOpenLocalPreview: useSetAtom(openBrowserAtom),
    onOpenBridgeRecoveryGuide: useSetAtom(openBridgeRecoveryGuideAtom),
    defaultStartCwd: useAtomValue(defaultStartCwdAtom),
    preferredAgentId: useAtomValue(preferredAgentIdAtom),
    agentSettings: useAtomValue(agentSettingsAtom),
    approvalMode: useAtomValue(approvalModeAtom),
    showToolCalls: useAtomValue(showToolCallsAtom),
    onDefaultStartCwdChange: useSetAtom(defaultStartCwdAtom),
    onLastUsedThreadSettingsChange: useSetAtom(rememberThreadSettingsAtom),
    onChatContextChange: useSetAtom(chatContextChangedAtom),
    onChatOpeningStateChange: useSetAtom(mainOpeningChatIdAtom),
    pendingOpenChatId: useAtomValue(pendingMainChatIdAtom),
    pendingOpenChatSnapshot: useAtomValue(pendingMainChatSnapshotAtom),
    onPendingOpenChatHandled,
  };
}
