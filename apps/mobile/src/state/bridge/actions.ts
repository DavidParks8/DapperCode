import { atom } from 'jotai';

import { normalizeBridgeToken, type BridgeProfileDraft } from '../../bridgeProfiles';
import { normalizeBridgeUrlInput } from '../../bridgeUrl';
import {
  deleteChatSnapshotCache,
  loadChatSnapshotCache,
  type ChatSnapshotCache,
} from '../../chatSnapshotCache';
import { deleteChatSummaryCache } from '../../chatSummaryCache';
import type { OnboardingBridgeProfileDraft } from '../../screens/onboarding/OnboardingScreen';
import { bridgeProfilesAtom, bridgeProfileStoreAtom } from '../appState/atoms';
import { dispatchDurableAppStateAtom } from '../appState/actions';
import { applyRestoredChatSnapshotAtom, resetChatSessionStateAtom } from '../chat/actions';
import { chatSnapshotCacheAtom } from '../chat/atoms';
import { activeBridgeProfileAtom, bridgeProfileTransitioningAtom } from './atoms';

function selectedSnapshotOf(cache: ChatSnapshotCache | null) {
  return cache?.entries.find((entry) => entry.chat.id === cache.selectedChatId)?.chat ?? null;
}

const applyRestoredCacheAtom = atom(null, (get, set, cache: ChatSnapshotCache | null): void => {
  set(chatSnapshotCacheAtom, cache);
  set(applyRestoredChatSnapshotAtom, selectedSnapshotOf(cache));
});

export interface SaveBridgeProfileInput {
  draft: OnboardingBridgeProfileDraft;
  mode: 'initial' | 'add' | 'edit' | 'reconnect';
  profileId?: string | null;
}

export const saveBridgeProfileAtom = atom(
  null,
  async (get, set, input: SaveBridgeProfileInput): Promise<string> => {
    const { draft, mode, profileId } = input;
    const normalized = normalizeBridgeUrlInput(draft.bridgeUrl);
    const normalizedToken = normalizeBridgeToken(draft.bridgeToken);
    if (!normalized || !normalizedToken) {
      throw new Error('Bridge URL and token are required.');
    }

    set(bridgeProfileTransitioningAtom, true);
    try {
      const nextDraft: BridgeProfileDraft = {
        id: mode === 'edit' ? (profileId ?? get(activeBridgeProfileAtom)?.id ?? null) : null,
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
        await Promise.all([
          deleteChatSnapshotCache(nextStore.activeProfileId),
          deleteChatSummaryCache(nextStore.activeProfileId),
        ]);
      }

      set(resetChatSessionStateAtom);
      const nextCache =
        nextStore.activeProfileId && !bridgeIdentityChanged
          ? await loadChatSnapshotCache(nextStore.activeProfileId)
          : null;
      set(applyRestoredCacheAtom, nextCache);
      if (!nextStore.activeProfileId) {
        throw new Error('Saving the bridge profile did not activate a profile.');
      }
      return nextStore.activeProfileId;
    } finally {
      set(bridgeProfileTransitioningAtom, false);
    }
  },
);

export const switchBridgeProfileAtom = atom(
  null,
  async (_get, set, profileId: string): Promise<void> => {
    set(bridgeProfileTransitioningAtom, true);
    try {
      const nextCache = await loadChatSnapshotCache(profileId);
      await set(dispatchDurableAppStateAtom, { type: 'profiles/switch', profileId });
      set(resetChatSessionStateAtom);
      set(applyRestoredCacheAtom, nextCache);
    } finally {
      set(bridgeProfileTransitioningAtom, false);
    }
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

export const deleteBridgeProfileAtom = atom(
  null,
  async (get, set, profileId: string): Promise<void> => {
    const deletingActiveProfile = get(activeBridgeProfileAtom)?.id === profileId;
    if (deletingActiveProfile) {
      set(bridgeProfileTransitioningAtom, true);
    }
    try {
      const nextState = await set(dispatchDurableAppStateAtom, {
        type: 'profiles/remove',
        profileId,
      });
      const nextStore = nextState.bridgeProfiles;
      await Promise.all([deleteChatSnapshotCache(profileId), deleteChatSummaryCache(profileId)]);

      if (deletingActiveProfile) {
        set(resetChatSessionStateAtom);
        const nextCache = nextStore.activeProfileId
          ? await loadChatSnapshotCache(nextStore.activeProfileId)
          : null;
        set(applyRestoredCacheAtom, nextCache);
      }
    } finally {
      if (deletingActiveProfile) {
        set(bridgeProfileTransitioningAtom, false);
      }
    }
  },
);

export const clearSavedBridgesAtom = atom(null, async (get, set): Promise<void> => {
  set(bridgeProfileTransitioningAtom, true);
  try {
    const profiles = get(bridgeProfilesAtom);
    await set(dispatchDurableAppStateAtom, { type: 'profiles/clear' });
    await Promise.all(
      profiles.flatMap((profile) => [
        deleteChatSnapshotCache(profile.id),
        deleteChatSummaryCache(profile.id),
      ]),
    );
    set(resetChatSessionStateAtom);
  } finally {
    set(bridgeProfileTransitioningAtom, false);
  }
});
