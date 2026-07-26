import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import { useAppTheme } from '../../theme';
import { createBrowserScreenStyles } from './browserScreenStyles';
import { VIEWPORT_MODES, type ViewportPreset } from './browserScreenShared';

export function StatusBanner({ tone, message }: { tone: 'warning' | 'error'; message: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const icon = tone === 'warning' ? 'warning-outline' : 'alert-circle-outline';
  const color = tone === 'warning' ? theme.colors.warning : theme.colors.error;

  return (
    <View
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
    </View>
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
  onOpenDrawer: () => void;
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
            hitSlop={6}
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
