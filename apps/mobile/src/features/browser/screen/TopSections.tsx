import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { Easing, FadeIn, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';

const MOTION_ROUTINE_MS = 200;
const EASING_STANDARD = [0.4, 0, 0.2, 1] as const;
import { useAppTheme } from '@shared/theme';
import { createBrowserScreenStyles } from './styles';
import { VIEWPORT_MODES, type ViewportPreset } from './shared';

export function StatusBanner({ tone, message }: { tone: 'warning' | 'error'; message: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const icon = tone === 'warning' ? 'warning-outline' : 'alert-circle-outline';
  const color = tone === 'warning' ? theme.colors.warning : theme.colors.error;

  return (
    <Animated.View
      entering={FadeIn.duration(MOTION_ROUTINE_MS)
        .easing(Easing.bezier(...EASING_STANDARD))
        .reduceMotion(ReduceMotion.System)}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={[
        styles.statusBanner,
        tone === 'warning' ? styles.statusBannerWarning : styles.statusBannerError,
      ]}
    >
      <Ionicons {...decorativeAccessibilityProps} name={icon} size={16} color={color} />
      <Text
        style={[
          styles.statusBannerText,
          tone === 'warning' ? styles.warningText : styles.errorText,
        ]}
      >
        {message}
      </Text>
    </Animated.View>
  );
}

export function BrowserTopBar({
  onOpenDrawer,
  inputValue,
  setInputValue,
  previewUrl,
  submitDisabled,
  supportsBrowserPreview,
  openingPreview,
  handleSubmitInput,
}: {
  onOpenDrawer?: () => void;
  inputValue: string;
  setInputValue: (value: string) => void;
  previewUrl: string | null;
  submitDisabled: boolean;
  supportsBrowserPreview: boolean;
  openingPreview: boolean;
  handleSubmitInput: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const { colors } = theme;

  return (
    <View style={styles.topBar}>
      {onOpenDrawer ? (
        <Pressable
          onPress={onOpenDrawer}
          hitSlop={8}
          style={styles.chromeButton}
          accessibilityRole="button"
          accessibilityLabel="Open navigation drawer"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="menu"
            size={20}
            color={colors.textPrimary}
          />
        </Pressable>
      ) : null}
      <View style={styles.omnibox}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={previewUrl ? 'globe-outline' : 'search-outline'}
          size={16}
          color={colors.textMuted}
        />
        <TextInput
          value={inputValue}
          onChangeText={setInputValue}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Search localhost or enter a port"
          placeholderTextColor={colors.textMuted}
          style={styles.omniboxInput}
          onSubmitEditing={handleSubmitInput}
          accessibilityLabel="Preview address"
          accessibilityHint="Enter a localhost address or port"
        />
        {inputValue.length > 0 ? (
          <Pressable
            onPress={() => setInputValue('')}
            hitSlop={10}
            style={({ pressed }) => [styles.omniboxIconButton, pressed && styles.iconButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Clear preview address"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="close"
              size={14}
              color={colors.textMuted}
            />
          </Pressable>
        ) : null}
        <Pressable
          onPress={handleSubmitInput}
          disabled={submitDisabled}
          hitSlop={6}
          style={({ pressed }) => [
            styles.submitButton,
            submitDisabled && styles.submitButtonDisabled,
            pressed && supportsBrowserPreview && !openingPreview && styles.submitButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={openingPreview ? 'Opening preview' : 'Open preview'}
          accessibilityState={controlAccessibilityState({
            disabled: submitDisabled,
            busy: openingPreview,
          })}
        >
          {openingPreview ? (
            <ActivityIndicator
              size="small"
              color={submitDisabled ? colors.textMuted : colors.accentText}
            />
          ) : (
            <Ionicons
              {...decorativeAccessibilityProps}
              name="arrow-forward"
              size={16}
              color={submitDisabled ? colors.textMuted : colors.accentText}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

export function ViewportTray({
  previewUrl,
  viewportPreset,
  desktopViewportLabel,
  desktopModeEnabled,
  showViewportMenu,
  applyViewportSelection,
  handleOpenViewportMenu,
}: {
  previewUrl: string | null;
  viewportPreset: ViewportPreset;
  desktopViewportLabel: string;
  desktopModeEnabled: boolean;
  showViewportMenu: boolean;
  applyViewportSelection: (preset: ViewportPreset) => void;
  handleOpenViewportMenu: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const { colors } = theme;

  if (!previewUrl) {
    return null;
  }

  return (
    <View style={styles.viewportTray}>
      <View style={styles.viewportModeRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.viewportModeScroller}
          contentContainerStyle={styles.viewportPresetRow}
        >
          {VIEWPORT_MODES.map((mode) => (
            <Pressable
              key={mode.key}
              onPress={() => applyViewportSelection(mode.key)}
              hitSlop={{ top: 7, bottom: 7 }}
              style={({ pressed }) => [
                styles.viewportPresetChip,
                viewportPreset === mode.key && styles.viewportPresetChipActive,
                pressed && styles.viewportPresetChipPressed,
              ]}
              accessibilityRole="radio"
              accessibilityState={{ checked: viewportPreset === mode.key }}
              accessibilityLabel={`${mode.label} viewport`}
            >
              <Text
                style={[
                  styles.viewportPresetChipText,
                  viewportPreset === mode.key && styles.viewportPresetChipTextActive,
                ]}
              >
                {mode.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          onPress={handleOpenViewportMenu}
          hitSlop={{ top: 7, bottom: 7 }}
          style={({ pressed }) => [
            styles.viewportSettingsButton,
            (desktopModeEnabled || showViewportMenu) && styles.viewportPresetChipActive,
            pressed && styles.viewportPresetChipPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Viewport size, ${desktopViewportLabel}`}
          accessibilityState={controlAccessibilityState({ expanded: showViewportMenu })}
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="options-outline"
            size={14}
            color={
              desktopModeEnabled || showViewportMenu ? colors.textPrimary : colors.textSecondary
            }
          />
          <Text
            style={[
              styles.viewportPresetChipText,
              (desktopModeEnabled || showViewportMenu) && styles.viewportPresetChipTextActive,
            ]}
          >
            {desktopViewportLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
