import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, TextInput, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import { formatRelativeTime, formatStatusCode } from './gitScreenUtils';
import type { GitSectionCommonProps } from './gitScreenSectionTypes';

export function GitScreenCommitHistorySection({
  controller,
  styles,
  theme,
}: GitSectionCommonProps) {
  const { derived } = controller;

  return (
    <>
      {derived.hasChanges ? (
        <>
          <View style={[styles.reviewCard, styles.reviewCardDirty]}>
            <View style={styles.reviewHeader}>
              <View style={styles.reviewIconWrap}>
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name={
                    derived.hasStagedFiles ? 'checkmark-done-circle-outline' : 'git-compare-outline'
                  }
                  size={18}
                  color={theme.colors.textPrimary}
                />
              </View>
              <View style={styles.reviewCopy}>
                <Text style={styles.reviewTitle}>{derived.reviewTitle}</Text>
                <Text style={styles.reviewDetail}>{derived.reviewDetail}</Text>
              </View>
            </View>
            <View style={styles.reviewStatsRow}>
              <View style={styles.reviewStat}>
                <Text style={styles.reviewStatLabel}>Files</Text>
                <Text style={styles.reviewStatValue}>{derived.changedFiles.length}</Text>
              </View>
              <View style={styles.reviewStat}>
                <Text style={styles.reviewStatLabel}>Added</Text>
                <Text style={[styles.reviewStatValue, styles.fileAdded]}>
                  +{derived.parsedDiff.totalAdditions}
                </Text>
              </View>
              <View style={styles.reviewStat}>
                <Text style={styles.reviewStatLabel}>Removed</Text>
                <Text style={[styles.reviewStatValue, styles.fileRemoved]}>
                  -{derived.parsedDiff.totalDeletions}
                </Text>
              </View>
            </View>
            {derived.reviewHighlights.length > 0 ? (
              <View style={styles.reviewFiles}>
                {derived.reviewHighlights.map((entry) => (
                  <View key={`${entry.code}:${entry.path}`} style={styles.reviewFileRow}>
                    <Text style={styles.reviewFileCode}>{formatStatusCode(entry.code)}</Text>
                    <Text style={styles.reviewFilePath} numberOfLines={1}>
                      {entry.path}
                    </Text>
                    {entry.stats ? (
                      <Text style={styles.reviewFileStats}>
                        +{entry.stats.additions} -{entry.stats.deletions}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}
            {derived.hasUnstagedFiles || derived.hasStagedFiles ? (
              <View style={styles.reviewActionRow}>
                {derived.hasUnstagedFiles ? (
                  <Pressable
                    onPress={() => void controller.stageAll()}
                    disabled={
                      controller.loading ||
                      controller.committing ||
                      controller.pushing ||
                      controller.stagingAll ||
                      controller.unstagingAll ||
                      Boolean(controller.stagingPath) ||
                      Boolean(controller.unstagingPath)
                    }
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.bulkActionBtn,
                      styles.bulkActionBtnStage,
                      pressed && styles.fileActionBtnPressed,
                      (controller.loading ||
                        controller.committing ||
                        controller.pushing ||
                        controller.stagingAll ||
                        controller.unstagingAll ||
                        Boolean(controller.stagingPath) ||
                        Boolean(controller.unstagingPath)) &&
                        styles.fileActionBtnDisabled,
                    ]}
                  >
                    <Text style={styles.bulkActionText}>
                      {controller.stagingAll ? 'Staging all...' : 'Stage all'}
                    </Text>
                  </Pressable>
                ) : null}
                {derived.hasStagedFiles ? (
                  <Pressable
                    onPress={() => void controller.unstageAll()}
                    disabled={
                      controller.loading ||
                      controller.committing ||
                      controller.pushing ||
                      controller.unstagingAll ||
                      controller.stagingAll ||
                      Boolean(controller.stagingPath) ||
                      Boolean(controller.unstagingPath)
                    }
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.bulkActionBtn,
                      styles.bulkActionBtnUnstage,
                      pressed && styles.fileActionBtnPressed,
                      (controller.loading ||
                        controller.committing ||
                        controller.pushing ||
                        controller.unstagingAll ||
                        controller.stagingAll ||
                        Boolean(controller.stagingPath) ||
                        Boolean(controller.unstagingPath)) &&
                        styles.fileActionBtnDisabled,
                    ]}
                  >
                    <Text style={styles.bulkActionText}>
                      {controller.unstagingAll ? 'Unstaging all...' : 'Unstage all'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>

          <Text style={styles.sectionLabel}>Commit message</Text>
          <TextInput
            style={styles.input}
            value={controller.commitMessage}
            onChangeText={controller.setCommitMessage}
            keyboardAppearance={theme.keyboardAppearance}
            placeholder="Commit message..."
            placeholderTextColor={theme.colors.textMuted}
          />

          <Pressable
            onPress={() => void controller.commit()}
            disabled={derived.commitButtonDisabled}
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && styles.actionBtnPressed,
              derived.commitButtonDisabled && styles.actionBtnDisabled,
            ]}
            accessibilityRole="button"
            accessibilityState={controlAccessibilityState({
              disabled: derived.commitButtonDisabled,
              busy: controller.committing,
            })}
          >
            <Text
              style={[
                styles.actionBtnText,
                derived.commitButtonDisabled && styles.actionBtnTextDisabled,
              ]}
            >
              {controller.committing
                ? 'Committing...'
                : derived.hasStagedFiles
                  ? 'Commit'
                  : 'Stage files first'}
            </Text>
          </Pressable>
        </>
      ) : null}

      {derived.showPushAction ? (
        <Pressable
          onPress={() => void controller.push()}
          disabled={derived.pushButtonDisabled}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.pushBtn,
            pressed && styles.actionBtnPressed,
            derived.pushButtonDisabled && styles.actionBtnDisabled,
          ]}
          accessibilityRole="button"
          accessibilityState={controlAccessibilityState({
            disabled: derived.pushButtonDisabled,
            busy: controller.pushing,
          })}
        >
          <Text
            style={[
              styles.actionBtnText,
              derived.pushButtonDisabled && styles.actionBtnTextDisabled,
            ]}
          >
            {derived.pushButtonLabel}
          </Text>
        </Pressable>
      ) : null}

      <Text style={styles.sectionLabel}>Recent commits</Text>
      <View style={styles.card}>
        {controller.history.length === 0 ? (
          <Text style={styles.emptyFilesText}>No commit history available.</Text>
        ) : (
          <View style={styles.historyList}>
            {controller.history.map((commit, index) => (
              <View
                key={commit.hash}
                style={[
                  styles.historyEntry,
                  index < controller.history.length - 1 && styles.historyEntryBorder,
                ]}
              >
                <View style={styles.historyEntryHeader}>
                  <Text style={styles.historyEntrySubject}>{commit.subject}</Text>
                  <View style={styles.historyHashBadge}>
                    <Text style={styles.historyHashBadgeText}>{commit.shortHash}</Text>
                  </View>
                </View>
                <Text style={styles.historyEntryMeta}>
                  {commit.authorName}
                  {' · '}
                  {formatRelativeTime(commit.authoredAt)}
                </Text>
                {commit.refNames.length > 0 ? (
                  <View style={styles.historyRefRow}>
                    {commit.refNames.map((refName) => (
                      <View
                        key={`${commit.hash}:${refName}`}
                        style={[
                          styles.historyRefChip,
                          commit.isHead &&
                            (refName === 'HEAD' || refName.startsWith('HEAD ->')) &&
                            styles.historyRefChipHead,
                        ]}
                      >
                        <Text style={styles.historyRefChipText}>{refName}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        )}
      </View>
    </>
  );
}
