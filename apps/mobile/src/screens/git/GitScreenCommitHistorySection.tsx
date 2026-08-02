import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, TextInput, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import type { GitScreenController } from './gitScreenController';
import { formatRelativeTime, formatStatusCode } from './gitScreenUtils';
import type { GitSectionCommonProps } from './gitScreenSectionTypes';

function isBulkStageActionDisabled(controller: GitScreenController): boolean {
  return (
    controller.loading ||
    controller.committing ||
    controller.pushing ||
    controller.stagingAll ||
    controller.unstagingAll ||
    Boolean(controller.stagingPath) ||
    Boolean(controller.unstagingPath)
  );
}

function GitReviewStatsRow({ controller, styles }: Omit<GitSectionCommonProps, 'theme'>) {
  const { derived } = controller;
  return (
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
  );
}

function GitReviewHighlights({ controller, styles }: Omit<GitSectionCommonProps, 'theme'>) {
  const { derived } = controller;
  if (derived.reviewHighlights.length === 0) {
    return null;
  }
  return (
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
  );
}

function GitReviewBulkActionRow({ controller, styles }: Omit<GitSectionCommonProps, 'theme'>) {
  const { derived } = controller;
  if (!derived.hasUnstagedFiles && !derived.hasStagedFiles) {
    return null;
  }
  const disabled = isBulkStageActionDisabled(controller);
  return (
    <View style={styles.reviewActionRow}>
      {derived.hasUnstagedFiles ? (
        <Pressable
          onPress={() => void controller.stageAll()}
          disabled={disabled}
          hitSlop={8}
          style={({ pressed }) => [
            styles.bulkActionBtn,
            styles.bulkActionBtnStage,
            pressed && styles.fileActionBtnPressed,
            disabled && styles.fileActionBtnDisabled,
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
          disabled={disabled}
          hitSlop={8}
          style={({ pressed }) => [
            styles.bulkActionBtn,
            styles.bulkActionBtnUnstage,
            pressed && styles.fileActionBtnPressed,
            disabled && styles.fileActionBtnDisabled,
          ]}
        >
          <Text style={styles.bulkActionText}>
            {controller.unstagingAll ? 'Unstaging all...' : 'Unstage all'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function GitReviewCard({ controller, styles, theme }: GitSectionCommonProps) {
  const { derived } = controller;
  return (
    <View style={[styles.reviewCard, styles.reviewCardDirty]}>
      <View style={styles.reviewHeader}>
        <View style={styles.reviewIconWrap}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={derived.hasStagedFiles ? 'checkmark-done-circle-outline' : 'git-compare-outline'}
            size={18}
            color={theme.colors.textPrimary}
          />
        </View>
        <View style={styles.reviewCopy}>
          <Text style={styles.reviewTitle}>{derived.reviewTitle}</Text>
          <Text style={styles.reviewDetail}>{derived.reviewDetail}</Text>
        </View>
      </View>
      <GitReviewStatsRow controller={controller} styles={styles} />
      <GitReviewHighlights controller={controller} styles={styles} />
      <GitReviewBulkActionRow controller={controller} styles={styles} />
    </View>
  );
}

function GitCommitComposer({ controller, styles, theme }: GitSectionCommonProps) {
  const { derived } = controller;
  return (
    <>
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
  );
}

function GitPushActionButton({ controller, styles }: Omit<GitSectionCommonProps, 'theme'>) {
  const { derived } = controller;
  return (
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
        style={[styles.actionBtnText, derived.pushButtonDisabled && styles.actionBtnTextDisabled]}
      >
        {derived.pushButtonLabel}
      </Text>
    </Pressable>
  );
}

function GitCommitHistoryList({ controller, styles }: Omit<GitSectionCommonProps, 'theme'>) {
  const { history } = controller;
  return (
    <>
      <Text style={styles.sectionLabel}>Recent commits</Text>
      <View style={styles.card}>
        {history.length === 0 ? (
          <Text style={styles.emptyFilesText}>No commit history available.</Text>
        ) : (
          <View style={styles.historyList}>
            {history.map((commit, index) => (
              <View
                key={commit.hash}
                style={[
                  styles.historyEntry,
                  index < history.length - 1 && styles.historyEntryBorder,
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
          <GitReviewCard controller={controller} styles={styles} theme={theme} />
          <GitCommitComposer controller={controller} styles={styles} theme={theme} />
        </>
      ) : null}

      {derived.showPushAction ? (
        <GitPushActionButton controller={controller} styles={styles} />
      ) : null}

      <GitCommitHistoryList controller={controller} styles={styles} />
    </>
  );
}
