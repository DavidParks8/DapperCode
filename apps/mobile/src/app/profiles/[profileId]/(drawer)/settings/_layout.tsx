import { Stack } from 'expo-router';

import { createStackScreenOptions } from '../../../../../navigation/stackScreenOptions';
import { useAppTheme } from '../../../../../theme';

export const unstable_settings = {
  anchor: 'index',
};

export default function SettingsLayout() {
  const theme = useAppTheme();
  return <Stack screenOptions={createStackScreenOptions(theme)} />;
}
