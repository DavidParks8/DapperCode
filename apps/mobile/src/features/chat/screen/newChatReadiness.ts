import { router } from 'expo-router';
import { useAtomValue } from 'jotai';
import { useCallback } from 'react';

import { LOCAL_SETUP_DESTINATIONS } from '@shell/profiles/localSetup';
import { localAgentPresenceAtom } from '@shell/state/local/atoms';

export interface NewChatReadiness {
  /** Why a chat cannot start yet, in the agent's words. */
  reason: string;
  /** The next step; absent when the workspace capsule is the action or there is nothing to do. */
  action: { label: string; hint: string; onPress: () => void } | null;
}

/**
 * Why the active agent cannot start a new chat yet, with the next step. Only agents that report
 * readiness (the local agent, which needs a downloaded model and a workspace) return one; a
 * desktop bridge always returns null.
 */
export function useNewChatReadiness(): NewChatReadiness | null {
  const presence = useAtomValue(localAgentPresenceAtom);
  // The same model setup destination the profile switcher's setup steps open.
  const openModels = useCallback(() => {
    router.push(LOCAL_SETUP_DESTINATIONS.models);
  }, []);
  const readiness = presence?.readiness;
  if (!readiness) {
    return null;
  }
  const needsModel = readiness.action === 'choose-model' || readiness.action === 'download-model';
  return {
    reason: readiness.reason,
    action: needsModel
      ? {
          label: 'Get a model',
          hint: 'Opens the model library to download or choose a model for this iPhone.',
          onPress: openModels,
        }
      : null,
  };
}
