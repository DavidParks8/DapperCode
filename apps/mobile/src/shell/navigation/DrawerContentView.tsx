import { Ionicons } from '@expo/vector-icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { memo, useMemo, type RefObject } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { CircularToolbarButton } from '@shared/ui/CircularToolbarButton';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { SelectionSheet, type SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { getDrawerFolderPickerLabels } from '@shell/navigation/drawerAttention';
import {
  createDrawerContentStyles,
  type DrawerContentStyles,
} from '@shell/navigation/drawerContentStyles';
import { formatCompactCount } from '@shell/navigation/drawerContentHelpers';
import type { DrawerScreen } from '@shell/navigation/drawerContentTypes';
import { useDrawerContentAtoms } from '@shell/navigation/drawerContentViewContext';
import { DrawerChatList } from '@shell/navigation/DrawerChatList';
import {
  formatBulkDeleteLabel,
  formatSelectionSummary,
  formatSelectionTitle,
} from '@shell/navigation/drawerSelection';

const CLEAR_SEARCH_HIT_SLOP = computeHitSlop({ width: 28, height: 28 });

interface DrawerVisualProps {
  styles: DrawerContentStyles;
  theme: AppTheme;
}

interface DrawerSelectionToolbarProps {
  handleDeleteSelectedChats: () => Promise<boolean>;
  styles: DrawerContentStyles;
}

const DrawerSelectionButton = memo(function DrawerSelectionButton({
  styles,
}: Pick<DrawerVisualProps, 'styles'>) {
  const atoms = useDrawerContentAtoms();
  const { hasAnySessions, selectionMode } = useAtomValue(atoms.selectionButtonStateAtom);
  const enterSelectionMode = useSetAtom(atoms.enterSelectionModeAtom);
  const exitSelectionMode = useSetAtom(atoms.exitSelectionModeAtom);

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
});

const DrawerSelectionToolbar = memo(function DrawerSelectionToolbar({
  handleDeleteSelectedChats,
  styles,
}: DrawerSelectionToolbarProps) {
  const atoms = useDrawerContentAtoms();
  const { allSelectableChatsSelected, selectedChatCount } = useAtomValue(
    atoms.selectionToolbarStateAtom,
  );
  const toggleSelectAllChats = useSetAtom(atoms.toggleSelectAllChatsAtom);

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
});

interface DrawerFooterProps extends DrawerVisualProps {
  handleNavigate: (screen: DrawerScreen) => void;
  handleOpenConnection: () => void;
}

const DrawerFooter = memo(function DrawerFooter({
  handleNavigate,
  handleOpenConnection,
  styles,
  theme,
}: DrawerFooterProps) {
  const atoms = useDrawerContentAtoms();
  const { totalChatCount, wsConnected } = useAtomValue(atoms.footerStateAtom);

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
});

interface DrawerHeaderProps extends DrawerVisualProps {
  handleClose?: () => void;
  handleNewChat: () => void;
}

const DrawerHeader = memo(function DrawerHeader({
  handleClose,
  handleNewChat,
  styles,
  theme,
}: DrawerHeaderProps) {
  const atoms = useDrawerContentAtoms();
  const {
    attentionCount,
    folderPickerVisible,
    isSearching,
    recentCount,
    searchQuery,
    searchResultCount,
    selectedChatCount,
    selectedFolderLabel,
    selectionMode,
    workingCount,
  } = useAtomValue(atoms.headerStateAtom);
  const clearSearch = useSetAtom(atoms.clearSearchAtom);
  const openFolderPicker = useSetAtom(atoms.openFolderPickerAtom);
  const setSearchQuery = useSetAtom(atoms.setSearchQueryAtom);
  const attentionSummary =
    attentionCount === 0
      ? 'No requests'
      : attentionCount === 1
        ? '1 needs you'
        : `${String(attentionCount)} need you`;

  return (
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
        <DrawerSelectionButton styles={styles} />
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
          <CircularToolbarButton accessibilityLabel="Close session list" onPress={handleClose}>
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
          onChangeText={setSearchQuery}
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
            onPress={clearSearch}
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
        // The debounced announcement effect is the only screen-reader channel for search results.
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
        onPress={openFolderPicker}
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
  );
});

interface DrawerBottomBarProps extends DrawerFooterProps, DrawerSelectionToolbarProps {}

const DrawerBottomBar = memo(function DrawerBottomBar({
  handleDeleteSelectedChats,
  handleNavigate,
  handleOpenConnection,
  styles,
  theme,
}: DrawerBottomBarProps) {
  const atoms = useDrawerContentAtoms();
  const selectionMode = useAtomValue(atoms.selectionModeAtom);
  return selectionMode ? (
    <DrawerSelectionToolbar handleDeleteSelectedChats={handleDeleteSelectedChats} styles={styles} />
  ) : (
    <DrawerFooter
      handleNavigate={handleNavigate}
      handleOpenConnection={handleOpenConnection}
      styles={styles}
      theme={theme}
    />
  );
});

const DrawerFolderPicker = memo(function DrawerFolderPicker() {
  const atoms = useDrawerContentAtoms();
  const { folderOptions, selectedFolderKey, visible } = useAtomValue(atoms.folderPickerStateAtom);
  const dismissFolderPicker = useSetAtom(atoms.dismissFolderPickerAtom);
  const selectFolder = useSetAtom(atoms.selectFolderAtom);
  const options = useMemo<SelectionSheetOption[]>(() => {
    const labels = getDrawerFolderPickerLabels(folderOptions);
    return folderOptions.map((option, index) => ({
      key: option.key ?? 'all',
      title: labels[index] ?? option.label,
      description: option.subtitle,
      meta: formatCompactCount(option.itemCount),
      icon: option.key ? 'folder-outline' : 'albums-outline',
      selected: option.key === selectedFolderKey,
      onPress: () => selectFolder(option.key),
    }));
  }, [folderOptions, selectFolder, selectedFolderKey]);

  return (
    <SelectionSheet
      visible={visible}
      eyebrow="Sessions"
      title="Folder"
      subtitle="Filter the session list by workspace folder."
      options={options}
      closeLabel="Done"
      onClose={dismissFolderPicker}
      presentation="expanded"
    />
  );
});

export interface DrawerContentViewProps {
  handleClose?: () => void;
  handleDeleteChat: (chatId: string) => Promise<boolean>;
  handleDeleteSelectedChats: () => Promise<boolean>;
  handleNavigate: (screen: DrawerScreen) => void;
  handleNewChat: () => void;
  handleOpenConnection: () => void;
  handleSelectChat: (chatId: string) => void;
  refreshDrawer: () => Promise<void>;
  retryDeepChatListRef: RefObject<() => Promise<void>>;
}

export const DrawerContentView = memo(function DrawerContentView({
  handleClose,
  handleDeleteChat,
  handleDeleteSelectedChats,
  handleNavigate,
  handleNewChat,
  handleOpenConnection,
  handleSelectChat,
  refreshDrawer,
  retryDeepChatListRef,
}: DrawerContentViewProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createDrawerContentStyles(theme), [theme]);

  return (
    <GlassSurface role="drawer" style={styles.container} testID="drawer-glass-surface">
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.mainContent}>
          <DrawerHeader
            handleClose={handleClose}
            handleNewChat={handleNewChat}
            styles={styles}
            theme={theme}
          />
          <DrawerChatList
            handleDeleteChat={handleDeleteChat}
            handleSelectChat={handleSelectChat}
            refreshDrawer={refreshDrawer}
            retryDeepChatListRef={retryDeepChatListRef}
            styles={styles}
            theme={theme}
          />
        </View>

        <DrawerBottomBar
          handleDeleteSelectedChats={handleDeleteSelectedChats}
          handleNavigate={handleNavigate}
          handleOpenConnection={handleOpenConnection}
          styles={styles}
          theme={theme}
        />
      </SafeAreaView>

      <DrawerFolderPicker />
    </GlassSurface>
  );
});
