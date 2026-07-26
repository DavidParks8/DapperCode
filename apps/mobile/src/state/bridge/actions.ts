import { atom } from 'jotai';

import { normalizeBridgeToken } from '../../app/appDrawerUtils';
import type { BridgeProfileDraft } from '../../bridgeProfiles';
import { normalizeBridgeUrlInput } from '../../bridgeUrl';
import {
  deleteChatSnapshotCache,
  loadChatSnapshotCache,
  type ChatSnapshotCache,
} from '../../chatSnapshotCache';
import type { OnboardingBridgeProfileDraft } from '../../screens/onboarding/OnboardingScreen';
import { bridgeProfilesAtom, bridgeProfileStoreAtom } from '../appState/atoms';
import { dispatchDurableAppStateAtom } from '../appState/actions';
import { applyRestoredChatSnapshotAtom, resetChatSessionStateAtom } from '../chat/actions';
import { chatSnapshotCacheAtom } from '../chat/atoms';
import { closeDrawerAtom } from '../drawer/atoms';
import {
  currentScreenAtom,
  onboardingModeAtom,
  onboardingReturnScreenAtom,
  toAppScreen,
} from '../navigation/atoms';
import { activeBridgeProfileAtom } from './atoms';

function selectedSnapshotOf(cache: ChatSnapshotCache | null) {
  return cache?.entries.find((entry) => entry.chat.id === cache.selectedChatId)?.chat ?? null;
}

const applyRestoredCacheAtom = atom(null, (get, set, cache: ChatSnapshotCache | null): void => {
  set(chatSnapshotCacheAtom, cache);
  set(applyRestoredChatSnapshotAtom, selectedSnapshotOf(cache));
});

export const saveBridgeProfileAtom = atom(
  null,
  async (get, set, draft: OnboardingBridgeProfileDraft): Promise<void> => {
    const normalized = normalizeBridgeUrlInput(draft.bridgeUrl);
    const normalizedToken = normalizeBridgeToken(draft.bridgeToken);
    if (!normalized || !normalizedToken) {
      throw new Error('Bridge URL and token are required.');
    }

    const onboardingMode = get(onboardingModeAtom);
    const nextDraft: BridgeProfileDraft = {
      id: onboardingMode === 'edit' ? (get(activeBridgeProfileAtom)?.id ?? null) : null,
      bridgeUrl: normalized,
      bridgeToken: normalizedToken,
      activate: true,
    };
    const editedProfile = nextDraft.id
      ? (get(bridgeProfileStoreAtom).profiles.find((profile) => profile.id === nextDraft.id) ??
        null)
      : null;
    const bridgeIdentityChanged = Boolean(
      editedProfile &&
      (editedProfile.bridgeUrl !== normalized || editedProfile.bridgeToken !== normalizedToken),
    );
    const nextState = await set(dispatchDurableAppStateAtom, {
      type: 'profiles/save',
      draft: nextDraft,
    });
    const nextStore = nextState.bridgeProfiles;
    if (bridgeIdentityChanged && nextStore.activeProfileId) {
      await deleteChatSnapshotCache(nextStore.activeProfileId);
    }

    set(resetChatSessionStateAtom);
    const nextCache =
      nextStore.activeProfileId && !bridgeIdentityChanged
        ? await loadChatSnapshotCache(nextStore.activeProfileId)
        : null;
    set(applyRestoredCacheAtom, nextCache);
    set(currentScreenAtom, onboardingMode === 'initial' ? 'Main' : get(onboardingReturnScreenAtom));
    set(onboardingModeAtom, 'edit');
    set(closeDrawerAtom);
  },
);

const openOnboardingAtom = atom(
  null,
  (get, set, mode: 'edit' | 'add' | 'reconnect' | 'initial'): void => {
    const currentScreen = get(currentScreenAtom);
    set(onboardingModeAtom, mode);
    set(onboardingReturnScreenAtom, toAppScreen(currentScreen, 'Settings'));
    set(currentScreenAtom, 'Onboarding');
    set(closeDrawerAtom);
  },
);

export const editBridgeProfileAtom = atom(null, (get, set): void => {
  set(openOnboardingAtom, get(activeBridgeProfileAtom)?.bridgeUrl ? 'edit' : 'initial');
});

export const addBridgeProfileAtom = atom(null, (get, set): void => {
  set(openOnboardingAtom, 'add');
});

export const openBridgeRecoveryGuideAtom = atom(null, (get, set): void => {
  set(openOnboardingAtom, 'reconnect');
});

export const switchBridgeProfileAtom = atom(
  null,
  async (get, set, profileId: string): Promise<void> => {
    const nextCache = await loadChatSnapshotCache(profileId);
    await set(dispatchDurableAppStateAtom, { type: 'profiles/switch', profileId });
    set(resetChatSessionStateAtom);
    set(applyRestoredCacheAtom, nextCache);
  },
);

export const renameBridgeProfileAtom = atom(
  null,
  async (get, set, profileId: string, nextName: string): Promise<void> => {
    await set(dispatchDurableAppStateAtom, {
      type: 'profiles/rename',
      profileId,
      name: nextName,
    });
  },
);

const resetToOnboardingAtom = atom(null, (get, set): void => {
  set(onboardingModeAtom, 'initial');
  set(onboardingReturnScreenAtom, 'Main');
  set(currentScreenAtom, 'Onboarding');
  set(closeDrawerAtom);
});

export const deleteBridgeProfileAtom = atom(
  null,
  async (get, set, profileId: string): Promise<void> => {
    const deletingActiveProfile = get(activeBridgeProfileAtom)?.id === profileId;
    const nextState = await set(dispatchDurableAppStateAtom, {
      type: 'profiles/remove',
      profileId,
    });
    const nextStore = nextState.bridgeProfiles;
    await deleteChatSnapshotCache(profileId);

    if (deletingActiveProfile) {
      set(resetChatSessionStateAtom);
      const nextCache = nextStore.activeProfileId
        ? await loadChatSnapshotCache(nextStore.activeProfileId)
        : null;
      set(applyRestoredCacheAtom, nextCache);
    }

    if (nextStore.profiles.length === 0) {
      set(resetToOnboardingAtom);
    }
  },
);

export const clearSavedBridgesAtom = atom(null, async (get, set): Promise<void> => {
  const profiles = get(bridgeProfilesAtom);
  await set(dispatchDurableAppStateAtom, { type: 'profiles/clear' });
  await Promise.all(profiles.map((profile) => deleteChatSnapshotCache(profile.id)));
  set(resetChatSessionStateAtom);
  set(resetToOnboardingAtom);
});

export const cancelOnboardingAtom = atom(null, (get, set): void => {
  set(currentScreenAtom, get(onboardingReturnScreenAtom));
});
