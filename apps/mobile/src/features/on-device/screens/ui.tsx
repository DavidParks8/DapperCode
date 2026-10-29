import { useCallback, useRef, useState, type PropsWithChildren, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme } from '@shared/theme';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';

export function useLocalOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback((operation: () => Promise<unknown>) => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    void operation()
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : 'The on-device operation failed.');
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }, []);
  return { busy, error, run };
}

export function LocalAction({
  title,
  onPress,
  disabled = false,
  destructive = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: theme.colors.bgItem, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 },
      ]}
    >
      <Text
        style={[
          theme.typography.label,
          { color: destructive ? theme.colors.error : theme.colors.accent },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function LocalText({
  children,
  title = false,
  mono = false,
}: PropsWithChildren<{ title?: boolean; mono?: boolean }>) {
  const theme = useAppTheme();
  return (
    <Text
      selectable
      style={[
        mono ? theme.typography.mono : title ? theme.typography.headline : theme.typography.body,
        { color: title ? theme.colors.textPrimary : theme.colors.textSecondary },
      ]}
    >
      {children}
    </Text>
  );
}

export function LocalError({ message }: { message: string | null }) {
  const theme = useAppTheme();
  return message ? (
    <Text
      accessibilityRole="alert"
      selectable
      style={[theme.typography.body, { color: theme.colors.error }]}
    >
      {message}
    </Text>
  ) : null;
}

export function LocalField({ label, ...props }: TextInputProps & { label: string }) {
  const theme = useAppTheme();
  return (
    <View style={styles.field}>
      <LocalText>{label}</LocalText>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance={theme.keyboardAppearance}
        placeholderTextColor={theme.colors.textMuted}
        {...props}
        style={[
          theme.typography.body,
          styles.input,
          {
            color: theme.colors.textPrimary,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.bgInput,
          },
          props.style,
        ]}
      />
    </View>
  );
}

export function LocalCard({ children }: PropsWithChildren) {
  const theme = useAppTheme();
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
      ]}
    >
      {children}
    </View>
  );
}

export function LocalPage({
  title,
  children,
  error = null,
  busy = false,
  scroll = true,
  navigation,
}: PropsWithChildren<{
  title: string;
  error?: string | null;
  busy?: boolean;
  scroll?: boolean;
  navigation?: ReactNode;
}>) {
  const router = useRouter();
  const theme = useAppTheme();
  const insets = useSceneHorizontalInsets();
  const contents = (
    <>
      <LocalError message={error} />
      {busy ? (
        <ActivityIndicator
          accessibilityLabel="Working on this iPhone"
          color={theme.colors.accent}
        />
      ) : null}
      {children}
    </>
  );
  return (
    <SafeAreaView
      style={[
        styles.page,
        {
          backgroundColor: theme.colors.bgMain,
          ...insets,
        },
      ]}
      edges={['top']}
    >
      <View style={styles.header}>
        {navigation ?? (
          <LocalAction
            title="Back"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/on-device'))}
          />
        )}
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[theme.typography.title, styles.heading, { color: theme.colors.textPrimary }]}
        >
          {title}
        </Text>
      </View>
      {scroll ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {contents}
        </ScrollView>
      ) : (
        <View style={styles.flex}>{contents}</View>
      )}
    </SafeAreaView>
  );
}

export function modelSize(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    minHeight: 64,
  },
  heading: { flex: 1 },
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 16,
    width: '100%',
    maxWidth: 800,
    alignSelf: 'center',
  },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 16, gap: 12 },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    justifyContent: 'center',
  },
  field: { gap: 8 },
  input: { minHeight: 48, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12 },
});
