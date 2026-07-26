import { atom } from 'jotai';

import type { AgentId, CollaborationMode } from '../../api/types';
import type { AppSettingsState } from '../../appState';
import { appSettingsAtom } from './atoms';
import { dispatchAppStateAtom } from './actions';

export const updateSettingsAtom = atom(
  null,
  (get, set, patch: Partial<AppSettingsState>): void => {
    set(dispatchAppStateAtom, { type: 'settings/update', patch });
  }
);

export const rememberThreadSettingsAtom = atom(
  null,
  (get, set, agentId: AgentId, collaborationMode: CollaborationMode): void => {
    set(dispatchAppStateAtom, { type: 'settings/remember-thread', agentId, collaborationMode });
  }
);

function settingAtom<Key extends keyof AppSettingsState>(key: Key) {
  return atom(
    (get) => get(appSettingsAtom)[key],
    (get, set, value: AppSettingsState[Key]) => {
      set(updateSettingsAtom, { [key]: value } as Partial<AppSettingsState>);
    }
  );
}

export const defaultStartCwdAtom = settingAtom('defaultStartCwd');
export const preferredAgentIdAtom = settingAtom('preferredAgentId');
export const agentSettingsAtom = settingAtom('agentSettings');
export const approvalModeAtom = settingAtom('approvalMode');
export const showToolCallsAtom = settingAtom('showToolCalls');
export const workspaceChatLimitAtom = settingAtom('workspaceChatLimit');
export const appearancePreferenceAtom = settingAtom('appearancePreference');
export const darkUiPaletteAtom = settingAtom('darkUiPalette');
export const fontPreferenceAtom = settingAtom('fontPreference');
export const recentBrowserTargetUrlsAtom = settingAtom('recentBrowserTargetUrls');
