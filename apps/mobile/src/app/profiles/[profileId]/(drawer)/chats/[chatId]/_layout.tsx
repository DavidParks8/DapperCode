import { Stack } from 'expo-router';

import { createStackScreenOptions } from '../../../../../../navigation/stackScreenOptions';
import { useAppTheme } from '../../../../../../theme';

export const unstable_settings = {
  anchor: 'index',
};

export default function ChatLayout() {
  const theme = useAppTheme();
  return (
    <Stack screenOptions={createStackScreenOptions(theme)}>
      <Stack.Screen name="index" />
      <Stack.Screen name="connection" options={{ presentation: 'modal', gestureEnabled: true }} />
    </Stack>
  );
}
