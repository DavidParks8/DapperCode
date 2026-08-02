import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '@shared/theme';

interface RouteErrorScreenProps {
  title: string;
  message: string;
  actionLabel?: string;
}

export function RouteErrorScreen({
  title,
  message,
  actionLabel = 'Return home',
}: RouteErrorScreenProps) {
  const router = useRouter();
  const theme = useAppTheme();

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bgMain }]} accessibilityRole="alert">
      <Text style={[styles.title, theme.typography.title, { color: theme.colors.textPrimary }]}>
        {title}
      </Text>
      <Text
        selectable
        style={[styles.message, theme.typography.body, { color: theme.colors.textSecondary }]}
      >
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.replace('/')}
        style={({ pressed }) => [
          styles.action,
          { backgroundColor: theme.colors.accent },
          pressed && styles.actionPressed,
        ]}
      >
        <Text
          style={[
            styles.actionLabel,
            theme.typography.headline,
            { color: theme.colors.bgMain, fontWeight: '700' },
          ]}
        >
          {actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  title: {
    textAlign: 'center',
  },
  message: {
    maxWidth: 520,
    textAlign: 'center',
  },
  action: {
    minHeight: 48,
    minWidth: 160,
    marginTop: 8,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPressed: {
    opacity: 0.8,
  },
  actionLabel: {},
});
