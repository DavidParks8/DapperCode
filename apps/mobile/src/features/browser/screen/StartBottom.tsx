import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import type { BrowserPreviewTargetSuggestion } from '@bridge/types/types';
import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { createBrowserScreenStyles } from './styles';
import { getCompactBrowserLabel } from './shared';

function QuickTargetTile({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
      style={({ pressed }) => [styles.quickTile, pressed && styles.quickTilePressed]}
    >
      <View style={styles.quickTileIcon}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={icon}
          size={16}
          color={theme.colors.textPrimary}
        />
      </View>
      <Text style={styles.quickTileTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.quickTileSubtitle} numberOfLines={2}>
        {subtitle}
      </Text>
    </Pressable>
  );
}

export function BrowserStartPage({
  suggestionsLoading,
  suggestions,
  recentTargetUrls,
  bottomBarReservedSpace,
  openPreview,
}: {
  suggestionsLoading: boolean;
  suggestions: BrowserPreviewTargetSuggestion[];
  recentTargetUrls: string[];
  bottomBarReservedSpace: number;
  openPreview: (target: string) => Promise<void>;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const { colors } = theme;

  return (
    <ScrollView
      style={styles.startPage}
      contentContainerStyle={[
        styles.startPageContent,
        { paddingBottom: bottomBarReservedSpace + theme.spacing.xl },
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.startHero}>
        <View style={styles.startHeroIcon}>
          <Ionicons name="globe-outline" size={20} color={colors.textPrimary} />
        </View>
        <Text style={styles.startHeroTitle}>Open a local preview</Text>
        <Text style={styles.startHeroSubtitle}>
          Use the search bar above or tap a running localhost target.
        </Text>
      </View>

      <View style={styles.quickSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Running now</Text>
          <Text style={styles.sectionSubtitle}>Detected local web servers.</Text>
        </View>
        {suggestionsLoading ? (
          <View
            style={styles.loadingInline}
            accessibilityRole="progressbar"
            accessibilityLabel="Scanning local web servers"
            accessibilityLiveRegion="polite"
          >
            <ActivityIndicator color={colors.textPrimary} />
            <Text style={styles.loadingInlineText}>Scanning local web servers...</Text>
          </View>
        ) : suggestions.length > 0 ? (
          <View style={styles.tileGrid}>
            {suggestions.map((suggestion, index) => (
              <QuickTargetTile
                key={`${suggestion.targetUrl}-${index}`}
                icon="flash-outline"
                title={getCompactBrowserLabel(suggestion.targetUrl)}
                subtitle={suggestion.label}
                onPress={() => {
                  void openPreview(suggestion.targetUrl);
                }}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.emptyStateText}>No local web servers responded right now.</Text>
        )}
      </View>

      <View style={styles.quickSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent</Text>
          <Text style={styles.sectionSubtitle}>Fast re-open targets.</Text>
        </View>
        {recentTargetUrls.length > 0 ? (
          <View style={styles.tileGrid}>
            {recentTargetUrls.map((target, index) => (
              <QuickTargetTile
                key={`${target}-${index}`}
                icon="time-outline"
                title={getCompactBrowserLabel(target)}
                subtitle={target}
                onPress={() => {
                  void openPreview(target);
                }}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.emptyStateText}>Open one preview and it will appear here.</Text>
        )}
      </View>
    </ScrollView>
  );
}

export function BrowserBottomBar({
  canGoBack,
  canGoForward,
  loadingPreview,
  previewUrl,
  handleGoBackPress,
  handleGoForwardPress,
  handleReload,
  handleShowStartPage,
  loadSuggestions,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  loadingPreview: boolean;
  previewUrl: string | null;
  handleGoBackPress: () => void;
  handleGoForwardPress: () => void;
  handleReload: () => void;
  handleShowStartPage: () => void;
  loadSuggestions: () => Promise<void>;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const { colors } = theme;

  return (
    <View style={styles.bottomBar}>
      <Pressable
        onPress={handleGoBackPress}
        disabled={Platform.OS === 'web' || !canGoBack}
        hitSlop={{ top: 5, bottom: 5 }}
        style={({ pressed }) => [
          styles.bottomNavButton,
          (Platform.OS === 'web' || !canGoBack) && styles.navButtonDisabled,
          pressed && Platform.OS !== 'web' && canGoBack && styles.iconButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Back"
        accessibilityState={controlAccessibilityState({
          disabled: Platform.OS === 'web' || !canGoBack,
        })}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="chevron-back"
          size={22}
          color={colors.textPrimary}
        />
      </Pressable>
      <Pressable
        onPress={handleGoForwardPress}
        disabled={Platform.OS === 'web' || !canGoForward}
        hitSlop={{ top: 5, bottom: 5 }}
        style={({ pressed }) => [
          styles.bottomNavButton,
          (Platform.OS === 'web' || !canGoForward) && styles.navButtonDisabled,
          pressed && Platform.OS !== 'web' && canGoForward && styles.iconButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Forward"
        accessibilityState={controlAccessibilityState({
          disabled: Platform.OS === 'web' || !canGoForward,
        })}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="chevron-forward"
          size={22}
          color={colors.textPrimary}
        />
      </Pressable>
      <Pressable
        onPress={handleReload}
        hitSlop={{ top: 5, bottom: 5 }}
        style={({ pressed }) => [
          styles.bottomNavButton,
          styles.bottomNavButtonPrimary,
          pressed && styles.bottomNavButtonPrimaryPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={
          loadingPreview
            ? 'Preview loading'
            : previewUrl
              ? 'Reload preview'
              : 'Scan for local previews'
        }
        accessibilityState={controlAccessibilityState({ busy: loadingPreview })}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={loadingPreview ? 'hourglass-outline' : 'refresh-outline'}
          size={20}
          color={colors.textPrimary}
        />
      </Pressable>
      <Pressable
        onPress={previewUrl ? handleShowStartPage : () => void loadSuggestions()}
        hitSlop={{ top: 5, bottom: 5 }}
        style={({ pressed }) => [styles.bottomNavButton, pressed && styles.iconButtonPressed]}
        accessibilityRole="button"
        accessibilityLabel={previewUrl ? 'Show preview start page' : 'Scan for local previews'}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={previewUrl ? 'home-outline' : 'scan-outline'}
          size={20}
          color={colors.textPrimary}
        />
      </Pressable>
    </View>
  );
}
