import { Stack } from 'expo-router';

export const unstable_settings = {
  anchor: 'index',
};

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="connection" options={{ presentation: 'modal', gestureEnabled: true }} />
    </Stack>
  );
}
