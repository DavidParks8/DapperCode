import { atom } from 'jotai';
import { router } from 'expo-router';

import { routes } from '@shell/navigation/routes';
import { getWorkspaceRouteIds } from '../state/workspaceRouteNavigation';

/** Opens the Files browser for a workspace over the given chat (or the active one). */
export const openWorkspaceFilesAtom = atom(
  null,
  (get, _set, args: { cwd: string; chatId?: string }): void => {
    const ids = getWorkspaceRouteIds(get);
    if (!ids.profileId || !args.cwd.trim()) {
      return;
    }
    router.push(routes.files(ids.profileId, args.chatId ?? ids.chatId, args.cwd));
  },
);
