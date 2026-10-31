import { Redirect, useLocalSearchParams } from 'expo-router';

import { routes } from '@shell/navigation/routes';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';

/** Local conversations open in the regular chat shell under the local profile. */
export default function LegacyLocalChatRoute() {
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();
  return (
    <Redirect
      href={threadId ? routes.chat(LOCAL_PROFILE_ID, threadId) : routes.newChat(LOCAL_PROFILE_ID)}
    />
  );
}
