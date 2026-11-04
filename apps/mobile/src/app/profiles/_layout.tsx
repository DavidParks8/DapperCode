import { Stack } from 'expo-router';

import { createStackScreenOptions } from '@shell/navigation/stackScreenOptions';
import { useAppTheme } from '@shared/theme';

/**
 * Gives `[profileId]` its own navigator. Expo Router only detects a changed dynamic segment on a
 * route named exactly `[param]`; under a flattened `profiles/[profileId]` route, switching profiles
 * replaced only the nested chat route and left the stale profile id on the parent, which a later
 * back navigation restored.
 */
export default function ProfilesLayout() {
  const theme = useAppTheme();
  return <Stack screenOptions={{ ...createStackScreenOptions(theme), animation: 'none' }} />;
}
