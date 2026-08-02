import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { computeHitSlop } from '../components/touchTarget';
import { getDrawerFolderPickerLabels } from './drawerAttention';
import { formatCompactCount } from './drawerContentHelpers';
import { SelectionSheet, type SelectionSheetOption } from '../components/SelectionSheet';
import { DrawerChatList } from './DrawerChatList';
import { useDrawerContentViewModel } from './drawerContentViewContext';

const CLEAR_SEARCH_HIT_SLOP = computeHitSlop({ width: 28, height: 28 });

export function DrawerContentView() {
  const {
    attentionCount,
    folderOptions,
    folderPickerVisible,
    handleClearSearch,
    handleClose,
    handleDismissFolderPicker,
    handleNavigate,
    handleNewChat,
    handleOpenConnection,
    handleOpenFolderPicker,
    handleSearchQueryChange,
    handleSelectFolder,
    isSearching,
    recentCount,
    searchQuery,
    searchResultCount,
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

            <View style={styles.searchField}>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="search"
                size={16}
                color={theme.colors.textMuted}
              />
              <TextInput
                accessibilityLabel="Search sessions"
                accessibilityHint="Filters sessions by title, workspace, agent, or status"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="never"
                onChangeText={handleSearchQueryChange}
                placeholder="Search sessions"
                placeholderTextColor={theme.colors.textMuted}
                returnKeyType="search"
                style={styles.searchInput}
                value={searchQuery}
              />
              {searchQuery.length > 0 ? (
                <Pressable
                  accessibilityLabel="Clear search"
                  accessibilityRole="button"
                  hitSlop={CLEAR_SEARCH_HIT_SLOP}
                  onPress={handleClearSearch}
                  style={({ pressed }) => [
                    styles.searchClearButton,
                    pressed && styles.searchClearButtonPressed,
                  ]}
                >
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name="close-circle"
                    size={18}
                    color={theme.colors.textMuted}
                  />
                </Pressable>
              ) : null}
            </View>

            {isSearching ? (
              // Visual summary only — the debounced useAccessibilityAnnouncement call in
              // DrawerContent.tsx is the single announcement channel for search results, so this
              // Text intentionally has no accessibilityLiveRegion to avoid a duplicate
              // announcement.
              <Text style={styles.searchResultSummary}>
                {searchResultCount === 0
                  ? `No sessions match "${searchQuery.trim()}"`
                  : `${String(searchResultCount)} ${searchResultCount === 1 ? 'session matches' : 'sessions match'} "${searchQuery.trim()}"`}
              </Text>
            ) : null}

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
          <Pressable
            accessibilityHint={
              wsConnected
                ? 'Opens the bridge connection settings.'
                : 'Opens the bridge connection settings to reconnect.'
            }
            accessibilityLabel={
              wsConnected
                ? 'Bridge connected. Edit connection'
                : 'Bridge offline. Reconnect or edit connection'
            }
            accessibilityLiveRegion="polite"
            accessibilityRole="button"
            onPress={handleOpenConnection}
            style={({ pressed }) => [
              styles.connectionStatus,
              pressed && styles.connectionStatusPressed,
            ]}
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
          </Pressable>
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
