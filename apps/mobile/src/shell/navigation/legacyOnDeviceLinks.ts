import type { Href } from 'expo-router';

import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { routes } from './routes';

/**
 * Maps a link into the retired `/on-device/*` screens (old bookmarks, notifications, and
 * universal links) to the matching On this iPhone profile route. Unknown paths open a new chat.
 */
export function legacyOnDeviceHref(path: string | readonly string[] | undefined): Href {
  const [section, id, ...rest] = typeof path === 'string' ? [path] : (path ?? []);
  const only = rest.length === 0;
  if (section === 'chat' && id && only) {
    return routes.chat(LOCAL_PROFILE_ID, id);
  }
  if (section === 'models' && only) {
    return id
      ? routes.settingsModelFamily(LOCAL_PROFILE_ID, id)
      : routes.settingsModels(LOCAL_PROFILE_ID);
  }
  if (section === 'account' && !id) {
    return routes.settingsGitHub(LOCAL_PROFILE_ID);
  }
  return routes.newChat(LOCAL_PROFILE_ID);
}
