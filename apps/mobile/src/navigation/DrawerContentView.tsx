import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { getDrawerFolderPickerLabels } from './drawerAttention';
import { formatCompactCount } from './drawerContentHelpers';
import { SelectionSheet, type SelectionSheetOption } from '../components/SelectionSheet';
import { DrawerChatList } from './DrawerChatList';
import { useDrawerContentViewModel } from './drawerContentViewContext';

export function DrawerContentView() {
  const {
    attentionCount,
    folderOptions,
    folderPickerVisible,
    handleClose,
    handleDismissFolderPicker,
    handleNavigate,
    handleNewChat,
    handleOpenFolderPicker,
    handleSelectFolder,
    recentCount,
    selectedFolderKey,
    selectedFolderLabel,
    styles,
    theme,
    totalChatCount,
    workingCount,
    wsConnected,
  } = useDrawerContentViewModel();
  const attentionSummary =
    attentionCount === 0
      ? 'No requests'
      : attentionCount === 1
        ? '1 needs you'
        : `${String(attentionCount)} need you`;
  const folderPickerLabels = getDrawerFolderPickerLabels(folderOptions);
  const folderSheetOptions = useMemo<SelectionSheetOption[]>(
    () =>
      folderOptions.map((option, index) => ({
        key: option.key ?? 'all',
        title: folderPickerLabels[index] ?? option.label,
        description: option.subtitle,
        meta: formatCompactCount(option.itemCount),
        icon: option.key ? 'folder-outline' : 'albums-outline',
        selected: option.key === selectedFolderKey,
        onPress: () => handleSelectFolder(option.key),
      })),
    [folderOptions, folderPickerLabels, handleSelectFolder, selectedFolderKey],
  );

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.mainContent}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.titleCopy}>
                <Text style={styles.title}>Agent activity</Text>
                <Text style={styles.subtitle}>Ordered by what needs you next</Text>
              </View>
              <Pressable
                accessibilityLabel="New chat"
                accessibilityRole="button"
                hitSlop={4}
                onPress={handleNewChat}
                style={({ pressed }) => [
                  styles.headerIconButton,
                  pressed && styles.headerIconButtonPressed,
                ]}
              >
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="add"
                  size={24}
                  color={theme.colors.accent}
                />
              </Pressable>
              {handleClose ? (
                <Pressable
                  accessibilityLabel="Close session list"
                  accessibilityRole="button"
                  hitSlop={4}
                  onPress={handleClose}
                  style={({ pressed }) => [
                    styles.headerIconButton,
                    pressed && styles.headerIconButtonPressed,
                  ]}
                >
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name="chevron-forward"
                    size={22}
                    color={theme.colors.accent}
                  />
                </Pressable>
              ) : null}
            </View>

            <View style={styles.statusSummary} accessibilityLiveRegion="polite">
              <Text style={styles.statusSummaryAttention}>{attentionSummary}</Text>
              <View style={styles.statusSummarySeparator} />
              <Text style={styles.statusSummaryText}>{`${String(workingCount)} working`}</Text>
              <View style={styles.statusSummarySeparator} />
              <Text style={styles.statusSummaryText}>{`${String(recentCount)} recent`}</Text>
            </View>

            <Pressable
              accessibilityLabel={`Filter sessions by folder, ${selectedFolderLabel}`}
              accessibilityRole="button"
              accessibilityState={controlAccessibilityState({
                expanded: folderPickerVisible,
              })}
              onPress={handleOpenFolderPicker}
              style={({ pressed }) => [styles.folderFilter, pressed && styles.folderFilterPressed]}
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="folder-outline"
                size={16}
                color={theme.colors.textMuted}
              />
              <Text style={styles.folderFilterLabel}>Folder</Text>
              <Text style={styles.folderFilterValue} numberOfLines={1}>
                {selectedFolderLabel}
              </Text>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="chevron-down"
                size={14}
                color={theme.colors.accent}
              />
            </Pressable>
          </View>

          <DrawerChatList />
        </View>

        <View style={styles.footer}>
          <View
            accessible
            accessibilityLabel={wsConnected ? 'Bridge connected' : 'Bridge offline'}
            accessibilityLiveRegion="polite"
            style={styles.connectionStatus}
          >
            <View
              style={[
                styles.connectionDot,
                wsConnected ? styles.connectionDotConnected : styles.connectionDotDisconnected,
              ]}
            />
            <View style={styles.connectionCopy}>
              <Text style={styles.connectionTitle}>
                {wsConnected ? 'Bridge connected' : 'Bridge offline'}
              </Text>
              <Text style={styles.connectionMeta}>
                {`${formatCompactCount(totalChatCount)} sessions`}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityLabel="Open preview browser"
            accessibilityRole="button"
            onPress={() => handleNavigate('Browser')}
            style={({ pressed }) => [
              styles.footerBrowserButton,
              pressed && styles.footerActionPressed,
            ]}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="globe-outline"
              size={17}
              color={theme.colors.accent}
            />
            <Text style={styles.footerBrowserText}>Browser</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Open settings"
            accessibilityRole="button"
            onPress={() => handleNavigate('Settings')}
            style={({ pressed }) => [
              styles.footerIconButton,
              pressed && styles.footerActionPressed,
            ]}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="settings-outline"
              size={18}
              color={theme.colors.accent}
            />
          </Pressable>
        </View>
      </SafeAreaView>

      <SelectionSheet
        visible={folderPickerVisible}
        eyebrow="Sessions"
        title="Folder"
        subtitle="Filter the session list by workspace folder."
        options={folderSheetOptions}
        closeLabel="Done"
        onClose={handleDismissFolderPicker}
        presentation="expanded"
      />
    </View>
  );
}
