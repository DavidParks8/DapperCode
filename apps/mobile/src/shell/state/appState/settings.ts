import { atom } from 'jotai';

import type { AgentId, CollaborationMode } from '@bridge/types/types';
import type { AppSettingsState } from '@shell/state/appState';
import { pushRecentModelId } from '@shell/state/appSettings';
import { appSettingsAtom } from '@shell/state/appState/atoms';
import { dispatchAppStateAtom } from '@shell/state/appState/actions';

export const updateSettingsAtom = atom(null, (get, set, patch: Partial<AppSettingsState>): void => {
  set(dispatchAppStateAtom, { type: 'settings/update', patch });
});

export const rememberThreadSettingsAtom = atom(
  null,
  (get, set, agentId: AgentId, collaborationMode: CollaborationMode): void => {
    set(dispatchAppStateAtom, { type: 'settings/remember-thread', agentId, collaborationMode });
  },
);

function settingAtom<Key extends keyof AppSettingsState>(key: Key) {
  return atom(
    (get) => get(appSettingsAtom)[key],
    (get, set, value: AppSettingsState[Key]) => {
      set(updateSettingsAtom, { [key]: value });
    },
  );
}

export const defaultStartCwdAtom = settingAtom('defaultStartCwd');
export const preferredAgentIdAtom = settingAtom('preferredAgentId');
export const agentSettingsAtom = settingAtom('agentSettings');
export const approvalModeAtom = settingAtom('approvalMode');
export const showToolCallsAtom = settingAtom('showToolCalls');
export const confirmSessionDeletionAtom = settingAtom('confirmSessionDeletion');
export const workspaceChatLimitAtom = settingAtom('workspaceChatLimit');
export const recentBrowserTargetUrlsAtom = settingAtom('recentBrowserTargetUrls');
export const recentModelIdsByAgentAtom = settingAtom('recentModelIdsByAgent');

export const rememberRecentModelIdAtom = atom(
  null,
  (get, set, agentId: AgentId, modelId: string): void => {
    const normalizedAgentId = agentId.trim();
    const normalizedModelId = modelId.trim();
    if (!normalizedAgentId || !normalizedModelId) {
      throw new Error('Recent model selections require non-empty agent and model IDs.');
    }

    const settings = get(appSettingsAtom);
    const currentModelIds = settings.recentModelIdsByAgent[normalizedAgentId] ?? [];
    const nextModelIds = pushRecentModelId(currentModelIds, normalizedModelId);
    if (
      currentModelIds.length === nextModelIds.length &&
      currentModelIds.every((value, index) => value === nextModelIds[index])
    ) {
      return;
    }

    set(updateSettingsAtom, {
      recentModelIdsByAgent: {
        ...settings.recentModelIdsByAgent,
        [normalizedAgentId]: nextModelIds,
      },
    });
  },
);
