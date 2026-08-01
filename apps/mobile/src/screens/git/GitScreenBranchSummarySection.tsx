import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import { formatRelativeTime } from './gitScreenUtils';
import type { GitSectionCommonProps } from './gitScreenSectionTypes';

export function GitScreenBranchSummarySection({
  controller,
  styles,
  theme,
}: GitSectionCommonProps) {
  const { derived, status, branchDraft, branchPanelOpen, switchingBranch } = controller;

  return (
    <View style={styles.card}>
      <View style={styles.branchHeaderRow}>
        <View style={styles.branchBadge}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="git-branch-outline"
            size={14}
            color={theme.colors.textPrimary}
          />
          <Text style={styles.branchBadgeText}>{status?.branch ?? '—'}</Text>
        </View>
        <View style={styles.branchActionsRow}>
          <View
            style={[
              styles.repoStateBadge,
              status?.clean ? styles.repoStateBadgeClean : styles.repoStateBadgeDirty,
            ]}
          >
            <Text style={styles.repoStateBadgeText}>{status?.clean ? 'Clean' : 'Changes'}</Text>
          </View>
          <Pressable
            onPress={controller.openBranchPanel}
            hitSlop={5}
            style={({ pressed }) => [
              styles.branchSwitchToggle,
              branchPanelOpen && styles.branchSwitchToggleActive,
              pressed && styles.branchSwitchTogglePressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Change branch"
            accessibilityState={controlAccessibilityState({ expanded: branchPanelOpen })}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="swap-horizontal-outline"
              size={14}
              color={theme.colors.textPrimary}
            />
            <Text style={styles.branchSwitchToggleText}>
              {branchPanelOpen ? 'Close' : 'Change branch'}
            </Text>
          </Pressable>
        </View>
      </View>
      {branchPanelOpen ? (
        <View style={styles.branchSwitchPanel}>
          <View style={styles.branchPanelHeader}>
            <Text style={styles.branchPanelTitle}>Branches</Text>
            {branchDraft ? (
              <Text style={styles.branchPanelSelected} numberOfLines={1}>
                Selected: {branchDraft}
              </Text>
            ) : null}
          </View>
          {derived.branchRows.length > 0 ? (
            <ScrollView
              style={styles.branchList}
              showsVerticalScrollIndicator
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.branchListContent}
              onTouchStart={controller.disableBodyScroll}
              onTouchCancel={controller.enableBodyScroll}
              onTouchEnd={controller.enableBodyScroll}
              onScrollBeginDrag={controller.disableBodyScroll}
              onScrollEndDrag={controller.enableBodyScroll}
              onMomentumScrollEnd={controller.enableBodyScroll}
            >
              {derived.branchRows.map((branch) => {
                const selected = branchDraft === branch.name;
                const branchMeta = branch.current
                  ? 'Current branch'
                  : branch.remote
                    ? 'Remote'
                    : 'Local';
                return (
                  <Pressable
                    key={`${branch.remote ? 'remote' : 'local'}:${branch.name}`}
                    onPress={() => controller.setBranchDraft(branch.name)}
                    disabled={switchingBranch}
                    style={({ pressed }) => [
                      styles.branchRow,
                      selected && styles.branchRowSelected,
                      pressed && styles.branchRowPressed,
                      switchingBranch && styles.fileActionBtnDisabled,
                    ]}
                    accessibilityRole="radio"
                    accessibilityLabel={`${branch.name}, ${branchMeta}`}
                    accessibilityState={{ checked: selected, disabled: switchingBranch }}
                  >
                    <View style={styles.branchRowTextBlock}>
                      <Text style={styles.branchRowName} numberOfLines={1}>
                        {branch.name}
                      </Text>
                      <Text style={styles.branchRowMeta}>{branchMeta}</Text>
                    </View>
                    <Ionicons
                      {...decorativeAccessibilityProps}
                      name={selected ? 'radio-button-on' : 'radio-button-off'}
                      size={18}
                      color={selected ? theme.colors.textPrimary : theme.colors.textMuted}
                    />
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : (
            <Text style={styles.emptyFilesText}>No branches found.</Text>
          )}
          <Pressable
            onPress={() => void controller.switchBranch()}
            disabled={derived.branchSwitchDisabled}
            style={({ pressed }) => [
              styles.branchSwitchButton,
              pressed && styles.actionBtnPressed,
              derived.branchSwitchDisabled && styles.actionBtnDisabled,
            ]}
            accessibilityRole="button"
            accessibilityState={controlAccessibilityState({
              disabled: derived.branchSwitchDisabled,
              busy: switchingBranch,
            })}
          >
            <Text
              style={[
                styles.branchSwitchButtonText,
                derived.branchSwitchDisabled && styles.actionBtnTextDisabled,
              ]}
            >
              {switchingBranch ? 'Switching...' : 'Switch'}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {derived.hasChanges ? (
        <View style={styles.statsGrid}>
          <View style={styles.statTile}>
            <Text style={styles.statTileLabel}>Changed</Text>
            <Text style={styles.statTileValue}>{derived.changedFiles.length}</Text>
          </View>
          <View style={styles.statTile}>
            <Text style={styles.statTileLabel}>Staged</Text>
            <Text style={styles.statTileValue}>{derived.stagedCount}</Text>
          </View>
          <View style={styles.statTile}>
            <Text style={styles.statTileLabel}>Unstaged</Text>
            <Text style={styles.statTileValue}>{derived.unstagedCount}</Text>
          </View>
          <View style={styles.statTile}>
            <Text style={styles.statTileLabel}>Untracked</Text>
            <Text style={styles.statTileValue}>{derived.untrackedCount}</Text>
          </View>
        </View>
      ) : null}
      {derived.upstreamDisplay || derived.syncDisplay || derived.latestCommit ? (
        <>
          <View style={styles.separator} />
          {derived.upstreamDisplay ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Upstream</Text>
              <Text style={styles.infoValue}>{derived.upstreamDisplay}</Text>
            </View>
          ) : null}
          {derived.syncDisplay ? (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Sync</Text>
              <Text style={styles.infoValue}>{derived.syncDisplay}</Text>
            </View>
          ) : null}
          {derived.latestCommit ? (
            <View style={styles.latestCommitBlock}>
              <View style={styles.latestCommitHeader}>
                <Text style={styles.latestCommitLabel}>Latest commit</Text>
                <Text style={styles.latestCommitHash}>{derived.latestCommit.shortHash}</Text>
              </View>
              <Text style={styles.latestCommitSubject}>{derived.latestCommit.subject}</Text>
              <Text style={styles.latestCommitMeta}>
                {derived.latestCommit.authorName}
                {' · '}
                {formatRelativeTime(derived.latestCommit.authoredAt)}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
