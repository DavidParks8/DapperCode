import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { getDrawerFolderPickerLabels } from '@shell/navigation/drawerAttention';
import { formatCompactCount } from '@shell/navigation/drawerContentHelpers';
import { SelectionSheet, type SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { DrawerChatList } from '@shell/navigation/DrawerChatList';
import { useDrawerContentViewModel } from '@shell/navigation/drawerContentViewContext';
import {
  formatBulkDeleteLabel,
  formatSelectionSummary,
  formatSelectionTitle,
} from '@shell/navigation/drawerSelection';
import { CircularToolbarButton } from '@shared/ui/CircularToolbarButton';

const CLEAR_SEARCH_HIT_SLOP = computeHitSlop({ width: 28, height: 28 });

/** `Edit` / `Cancel` affordance that opens and closes bulk selection. */
function DrawerSelectionButton() {
  const { enterSelectionMode, exitSelectionMode, hasAnySessions, selectionMode, styles } =
    useDrawerContentViewModel();

  if (!selectionMode && !hasAnySessions) {
    return null;
  }

  return (
    <Pressable
      accessibilityHint={
        selectionMode
          ? 'Leaves selection mode without deleting.'
          : 'Starts selecting sessions to delete in bulk.'
      }
      accessibilityLabel={selectionMode ? 'Cancel selecting sessions' : 'Select sessions'}
      accessibilityRole="button"
      onPress={selectionMode ? exitSelectionMode : enterSelectionMode}
      style={({ pressed }) => [styles.headerTextButton, pressed && styles.headerTextButtonPressed]}
    >
      <Text style={styles.headerTextButtonLabel}>{selectionMode ? 'Cancel' : 'Edit'}</Text>
    </Pressable>
  );
}

/** Bottom bar that replaces the footer while selecting, mirroring the iOS Mail edit toolbar. */
function DrawerSelectionToolbar() {
  const {
    allSelectableChatsSelected,
    handleDeleteSelectedChats,
    selectedChatCount,
    styles,
    toggleSelectAllChats,
  } = useDrawerContentViewModel();

  return (
    <View style={styles.selectionToolbar}>
      <Pressable
        accessibilityHint={
          allSelectableChatsSelected
            ? 'Clears the current selection.'
            : 'Selects every session currently listed.'
        }
        accessibilityLabel={
          allSelectableChatsSelected ? 'Deselect all sessions' : 'Select all sessions'
        }
        accessibilityRole="button"
        onPress={toggleSelectAllChats}
        style={({ pressed }) => [
          styles.selectionToolbarButton,
          pressed && styles.selectionToolbarButtonPressed,
        ]}
      >
        <Text style={styles.selectionToolbarLabel}>
          {allSelectableChatsSelected ? 'Deselect All' : 'Select All'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityHint="Deletes every selected session."
        accessibilityLabel={
          selectedChatCount === 0
            ? 'Delete selected sessions'
            : `Delete ${String(selectedChatCount)} selected ${selectedChatCount === 1 ? 'session' : 'sessions'}`
        }
        accessibilityRole="button"
        accessibilityState={controlAccessibilityState({ disabled: selectedChatCount === 0 })}
        disabled={selectedChatCount === 0}
        onPress={() => {
          void handleDeleteSelectedChats();
        }}
        style={({ pressed }) => [
          styles.selectionToolbarButton,
          pressed && selectedChatCount > 0 && styles.selectionToolbarButtonPressed,
        ]}
      >
        <Text
          style={[
            styles.selectionToolbarDeleteLabel,
            selectedChatCount === 0 && styles.selectionToolbarLabelDisabled,
          ]}
        >
          {formatBulkDeleteLabel(selectedChatCount)}
        </Text>
      </Pressable>
    </View>
  );
}

function DrawerFooter() {
  const { handleNavigate, handleOpenConnection, styles, theme, totalChatCount, wsConnected } =
    useDrawerContentViewModel();

  return (
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
        style={({ pressed }) => [styles.footerBrowserButton, pressed && styles.footerActionPressed]}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="globe-outline"
          size={17}
          color={theme.colors.userBubble}
        />
        <Text style={styles.footerBrowserText}>Browser</Text>
      </Pressable>
      <CircularToolbarButton
        accessibilityLabel="Open settings"
        onPress={() => handleNavigate('Settings')}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="settings-outline"
          size={18}
          color={theme.colors.userBubble}
        />
      </CircularToolbarButton>
    </View>
  );
}

export function DrawerContentView() {
  const {
    attentionCount,
    folderOptions,
    folderPickerVisible,
    handleClearSearch,
    handleClose,
    handleDismissFolderPicker,
    handleNewChat,
    handleOpenFolderPicker,
    handleSearchQueryChange,
    handleSelectFolder,
    isSearching,
    recentCount,
    searchQuery,
    searchResultCount,
    selectedChatCount,
    selectedFolderKey,
    selectedFolderLabel,
    selectionMode,
    styles,
    theme,
    workingCount,
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
    <GlassSurface role="drawer" style={styles.container} testID="drawer-glass-surface">
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.mainContent}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.titleCopy}>
                <Text style={styles.title}>
                  {selectionMode ? formatSelectionTitle(selectedChatCount) : 'Agent activity'}
                </Text>
                <Text style={styles.subtitle}>
                  {selectionMode
                    ? 'Swipe actions pause while selecting'
                    : 'Ordered by what needs you next'}
                </Text>
              </View>
              <DrawerSelectionButton />
              {selectionMode ? null : (
                <CircularToolbarButton accessibilityLabel="New chat" onPress={handleNewChat}>
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name="add"
                    size={24}
                    color={theme.colors.userBubble}
                  />
                </CircularToolbarButton>
              )}
              {handleClose && !selectionMode ? (
                <CircularToolbarButton
                  accessibilityLabel="Close session list"
                  onPress={handleClose}
                >
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name="chevron-forward"
                    size={22}
                    color={theme.colors.userBubble}
                  />
                </CircularToolbarButton>
              ) : null}
            </View>

            <View style={styles.statusSummary} accessibilityLiveRegion="polite">
              {selectionMode ? (
                <Text style={styles.statusSummaryAttention}>
                  {formatSelectionSummary(selectedChatCount)}
                </Text>
              ) : (
                <>
                  <Text style={styles.statusSummaryAttention}>{attentionSummary}</Text>
                  <View style={styles.statusSummarySeparator} />
                  <Text style={styles.statusSummaryText}>{`${String(workingCount)} working`}</Text>
                  <View style={styles.statusSummarySeparator} />
                  <Text style={styles.statusSummaryText}>{`${String(recentCount)} recent`}</Text>
                </>
              )}
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
                color={theme.colors.userBubble}
              />
            </Pressable>
          </View>

          <DrawerChatList />
        </View>

        {selectionMode ? <DrawerSelectionToolbar /> : <DrawerFooter />}
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
    </GlassSurface>
  );
}
