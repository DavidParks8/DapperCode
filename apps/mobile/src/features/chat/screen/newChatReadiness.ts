import { router } from 'expo-router';
import { useAtomValue } from 'jotai';
import { useCallback } from 'react';

import { routes } from '@shell/navigation/routes';
import { activeProfileIdAtom } from '@shell/state/bridge/atoms';
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
  const profileId = useAtomValue(activeProfileIdAtom);
  const openModels = useCallback(() => {
    if (profileId) {
      router.push(routes.settings(profileId));
    }
  }, [profileId]);
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
          hint: 'Opens Settings to download or choose a model for this iPhone.',
          onPress: openModels,
        }
      : null,
  };
}
