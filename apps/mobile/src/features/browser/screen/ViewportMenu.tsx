import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppSheet } from '@shared/ui/AppSheet';
import { useAppTheme } from '@shared/theme';
import { createBrowserScreenStyles } from './styles';
import { DESKTOP_VIEWPORT_PRESETS } from './shared';

export function ViewportMenu({
  showViewportMenu,
  handleCloseViewportMenu,
  viewportMenuFocusRef,
  desktopViewportSize,
  showCustomViewportEditor,
  desktopViewportMatchesPreset,
  desktopViewportDraft,
  setDesktopViewportDraft,
  handleSelectDesktopPreset,
  handleShowCustomViewportEditor,
  handleApplyDesktopViewport,
}: {
  showViewportMenu: boolean;
  handleCloseViewportMenu: () => void;
  viewportMenuFocusRef: (instance: Text | null) => void;
  desktopViewportSize: { width: number; height: number };
  showCustomViewportEditor: boolean;
  desktopViewportMatchesPreset: boolean;
  desktopViewportDraft: { width: string; height: string };
  setDesktopViewportDraft: (
    updater: (current: { width: string; height: string }) => { width: string; height: string },
  ) => void;
  handleSelectDesktopPreset: (viewport: { width: number; height: number }) => void;
  handleShowCustomViewportEditor: () => void;
  handleApplyDesktopViewport: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const { colors } = theme;

  return (
    <AppSheet
      visible={showViewportMenu}
      onClose={handleCloseViewportMenu}
      accessibilityLabel="Viewport menu"
    >
      <View style={styles.viewportMenuHeader}>
        <Text
          ref={viewportMenuFocusRef}
          accessibilityRole="header"
          style={styles.viewportMenuTitle}
        >
          Viewport
        </Text>
        <Text style={styles.viewportMenuSubtitle}>Applies to Desktop.</Text>
      </View>
      <View style={styles.viewportMenuPresetGrid}>
        {DESKTOP_VIEWPORT_PRESETS.map((preset) => {
          const active =
            desktopViewportSize.width === preset.width &&
            desktopViewportSize.height === preset.height;
          return (
            <Pressable
              key={preset.label}
              onPress={() => handleSelectDesktopPreset(preset)}
              style={({ pressed }) => [
                styles.viewportPresetChip,
                styles.viewportMenuPresetChip,
                active && styles.viewportPresetChipActive,
                pressed && styles.viewportPresetChipPressed,
              ]}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
            >
              <Text
                style={[
                  styles.viewportPresetChipText,
                  active && styles.viewportPresetChipTextActive,
                ]}
              >
                {preset.label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={handleShowCustomViewportEditor}
          style={({ pressed }) => [
            styles.viewportPresetChip,
            styles.viewportMenuPresetChip,
            (showCustomViewportEditor || !desktopViewportMatchesPreset) &&
              styles.viewportPresetChipActive,
            pressed && styles.viewportPresetChipPressed,
          ]}
          accessibilityRole="radio"
          accessibilityState={{
            checked: showCustomViewportEditor || !desktopViewportMatchesPreset,
          }}
        >
          <Text
            style={[
              styles.viewportPresetChipText,
              (showCustomViewportEditor || !desktopViewportMatchesPreset) &&
                styles.viewportPresetChipTextActive,
            ]}
          >
            Custom
          </Text>
        </Pressable>
      </View>
      {showCustomViewportEditor ? (
        <View style={styles.viewportInputRow}>
          <View style={styles.viewportField}>
            <Text style={styles.viewportFieldLabel}>W</Text>
            <BottomSheetTextInput
              value={desktopViewportDraft.width}
              onChangeText={(value) =>
                setDesktopViewportDraft((current) => ({ ...current, width: value }))
              }
              keyboardType="number-pad"
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.viewportFieldInput}
              placeholder="1920"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Viewport width"
            />
          </View>
          <View style={styles.viewportField}>
            <Text style={styles.viewportFieldLabel}>H</Text>
            <BottomSheetTextInput
              value={desktopViewportDraft.height}
              onChangeText={(value) =>
                setDesktopViewportDraft((current) => ({ ...current, height: value }))
              }
              keyboardType="number-pad"
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.viewportFieldInput}
              placeholder="1080"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Viewport height"
            />
          </View>
          <Pressable
            onPress={handleApplyDesktopViewport}
            style={({ pressed }) => [
              styles.viewportApplyButton,
              pressed && styles.viewportApplyButtonPressed,
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.viewportApplyButtonText}>Apply</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.viewportCurrentLabel}>
          Current viewport: {desktopViewportSize.width}×{desktopViewportSize.height}
        </Text>
      )}
      <View style={styles.viewportMenuFooter}>
        <Pressable
          onPress={handleCloseViewportMenu}
          accessibilityRole="button"
          accessibilityLabel="Close viewport menu"
          style={styles.viewportMenuCloseButton}
        >
          <Text style={styles.viewportMenuCloseText}>Done</Text>
        </Pressable>
      </View>
    </AppSheet>
  );
}
