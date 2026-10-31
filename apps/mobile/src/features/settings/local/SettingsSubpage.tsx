import { useMemo, useState, type ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme, type AppTheme } from '@shared/theme';
import { SceneToolbarHost, useInlineToolbar } from '@shell/layout/SceneToolbar';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';
import { LARGE_TITLE_COLLAPSE_OFFSET, SettingsHeader } from '../SettingsHeader';

/**
 * A page pushed onto the Settings stack: back button, iOS large title that collapses into the bar,
 * and grouped sections on the grouped background. Matches the root Settings page.
 */
export function SettingsSubpage({
  title,
  onBack,
  children,
  testID,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const sceneInsets = useSceneHorizontalInsets();
  const inlineToolbar = useInlineToolbar();
  const [collapsed, setCollapsed] = useState(false);
  const backLabel = 'Back to Settings';

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > LARGE_TITLE_COLLAPSE_OFFSET;
    setCollapsed((current) => (current === next ? current : next));
  };

  return (
    <SceneToolbarHost
      items={[
        {
          key: 'back',
          icon: 'chevron-back',
          label: backLabel,
          onPress: onBack,
          group: 'navigation',
        },
      ]}
    >
      <SafeAreaView style={[styles.safeArea, sceneInsets]} edges={['top']} testID={testID}>
        <SettingsHeader
          title={title}
          collapsed={collapsed}
          onBackPress={inlineToolbar ? onBack : undefined}
          backLabel={backLabel}
        />
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScroll={handleScroll}
          scrollEventThrottle={16}
          scrollIndicatorInsets={{ right: 1 }}
        >
          <Text accessibilityRole="header" style={styles.largeTitle}>
            {title}
          </Text>
          {children}
        </ScrollView>
      </SafeAreaView>
    </SceneToolbarHost>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: theme.colors.bgMain },
    content: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xs,
      gap: theme.spacing.xxl,
    },
    largeTitle: { ...theme.typography.largeTitle },
  });
}
