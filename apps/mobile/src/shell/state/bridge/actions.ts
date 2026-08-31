import { atom, type Getter } from 'jotai';

import { normalizeBridgeToken, type BridgeProfileDraft } from '@shell/state/bridgeProfiles';
import { normalizeBridgeUrlInput } from '@shell/state/bridgeUrl';
import {
  deleteChatSnapshotCache,
  loadChatSnapshotCache,
  type ChatSnapshotCache,
} from '@shell/session/chatSnapshotCache';
import { deleteChatSummaryCache } from '@shell/session/chatSummaryCache';
import type { OnboardingBridgeProfileDraft } from '../../../features/onboarding/screen/OnboardingScreen';
import { bridgeProfileStoreAtom } from '@shell/state/appState/atoms';
import { dispatchDurableAppStateAtom } from '@shell/state/appState/actions';
import {
  applyRestoredChatSnapshotAtom,
  resetChatSessionStateAtom,
} from '@shell/state/chat/actions';
import { chatSnapshotCacheAtom } from '@shell/state/chat/atoms';
import { activeBridgeProfileAtom, bridgeProfileTransitioningAtom } from '@shell/state/bridge/atoms';

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

function normalizeSaveBridgeProfileInput(draft: OnboardingBridgeProfileDraft) {
  const normalized = normalizeBridgeUrlInput(draft.bridgeUrl);
  const normalizedToken = normalizeBridgeToken(draft.bridgeToken);
  if (!normalized || !normalizedToken) {
    throw new Error('Bridge URL and token are required.');
  }
  return { normalized, normalizedToken };
}

function resolveSaveBridgeProfileDraft(
  get: Getter,
  input: SaveBridgeProfileInput,
  normalized: string,
  normalizedToken: string,
): { nextDraft: BridgeProfileDraft; bridgeIdentityChanged: boolean } {
  const { mode, profileId } = input;
  const nextDraft: BridgeProfileDraft = {
    id: mode === 'edit' ? (profileId ?? get(activeBridgeProfileAtom)?.id ?? null) : null,
    bridgeUrl: normalized,
    bridgeToken: normalizedToken,
    workspaceId: input.draft.workspaceId ?? null,
    activate: true,
  };
  const editedProfile = nextDraft.id
    ? (get(bridgeProfileStoreAtom).profiles.find((profile) => profile.id === nextDraft.id) ?? null)
    : null;
  const bridgeIdentityChanged = Boolean(
    editedProfile &&
    (editedProfile.bridgeUrl !== normalized ||
      editedProfile.bridgeToken !== normalizedToken ||
      editedProfile.workspaceId !== (input.draft.workspaceId ?? null)),
  );
  return { nextDraft, bridgeIdentityChanged };
}

export const saveBridgeProfileAtom = atom(
  null,
  async (get, set, input: SaveBridgeProfileInput): Promise<string> => {
    const { normalized, normalizedToken } = normalizeSaveBridgeProfileInput(input.draft);

    set(bridgeProfileTransitioningAtom, true);
    try {
      const { nextDraft, bridgeIdentityChanged } = resolveSaveBridgeProfileDraft(
        get,
        input,
        normalized,
        normalizedToken,
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
