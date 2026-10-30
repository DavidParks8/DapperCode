import { Redirect } from 'expo-router';

import { routes } from '@shell/navigation/routes';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';

/** The old on-device hub is replaced by the local profile in the regular chat shell. */
export default function OnDeviceRoute() {
  return <Redirect href={routes.newChat(LOCAL_PROFILE_ID)} />;
}
