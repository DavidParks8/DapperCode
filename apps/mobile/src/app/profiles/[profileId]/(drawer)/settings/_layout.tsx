import { Stack } from 'expo-router';

import { createStackScreenOptions } from '@shell/navigation/stackScreenOptions';
import { useAppTheme } from '@shared/theme';

export const unstable_settings = {
  anchor: 'index',
};

export default function SettingsLayout() {
  const theme = useAppTheme();
  return (
    <Stack screenOptions={createStackScreenOptions(theme)}>
      <Stack.Screen name="index" />
      <Stack.Screen name="connection" options={{ presentation: 'modal', gestureEnabled: true }} />
    </Stack>
  );
}
