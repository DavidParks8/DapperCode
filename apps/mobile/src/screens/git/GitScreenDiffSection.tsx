import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { createGitReviewTarget } from './gitDiffReview';
import type { GitScreenController } from './gitScreenController';
import type { GitChangedFileWithStats } from './gitScreenTypes';
import { formatDiffLineNumber, formatStatusCode } from './gitScreenUtils';
import type { GitSectionCommonProps } from './gitScreenSectionTypes';

function isFileStageActionDisabled(controller: GitScreenController, stagePath: string): boolean {
  return (
    controller.loading ||
    controller.committing ||
    controller.pushing ||
    controller.stagingAll ||
    controller.unstagingAll ||
    controller.stagingPath === stagePath ||
    controller.unstagingPath === stagePath
  );
}

function GitDiffFileRow({
  entry,
  controller,
  styles,
}: {
  entry: GitChangedFileWithStats;
  controller: GitScreenController;
  styles: GitSectionCommonProps['styles'];
}) {
  const actionDisabled = isFileStageActionDisabled(controller, entry.stagePath);
  return (
    <View style={styles.fileRow}>
      <Text style={styles.fileCode}>{formatStatusCode(entry.code)}</Text>
      {entry.diffFileId ? (
        <Pressable
          style={styles.filePathPressable}
          onPress={() => {
            if (entry.diffFileId) {
              controller.selectDiffFile(entry.diffFileId);
            }
          }}
          disabled={controller.showDiffFileSwitching}
        >
          <Text
            style={[
              styles.filePath,
              styles.filePathInteractive,
              controller.showDiffFileSwitching && styles.filePathDisabled,
            ]}
          >
            {entry.path}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.filePath}>{entry.path}</Text>
      )}
      {entry.stats ? (
        <View style={styles.fileStats}>
          <Text style={styles.fileAdded}>+{entry.stats.additions}</Text>
          <Text style={styles.fileRemoved}>-{entry.stats.deletions}</Text>
        </View>
      ) : null}
      <View style={styles.fileActions}>
        {entry.unstaged ? (
          <Pressable
            onPress={() => void controller.stageFile(entry.stagePath)}
            disabled={actionDisabled}
            hitSlop={8}
            style={({ pressed }) => [
              styles.fileActionBtn,
              styles.fileActionBtnStage,
              pressed && styles.fileActionBtnPressed,
              actionDisabled && styles.fileActionBtnDisabled,
            ]}
          >
            <Text style={styles.fileActionText}>
              {controller.stagingPath === entry.stagePath ? 'Staging...' : 'Stage'}
            </Text>
          </Pressable>
        ) : null}
        {entry.staged ? (
          <Pressable
            onPress={() => void controller.unstageFile(entry.stagePath)}
            disabled={actionDisabled}
            hitSlop={8}
            style={({ pressed }) => [
              styles.fileActionBtn,
              styles.fileActionBtnUnstage,
              pressed && styles.fileActionBtnPressed,
              actionDisabled && styles.fileActionBtnDisabled,
            ]}
          >
            <Text style={styles.fileActionText}>
              {controller.unstagingPath === entry.stagePath ? 'Unstaging...' : 'Unstage'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function GitScreenDiffSection({ controller, styles, theme }: GitSectionCommonProps) {
  const { derived, diffFileForView } = controller;

  // Only claim a clean working tree once a status fetch has actually succeeded (no active
  // error) and returned no changes. Falling through to `null` for an initial/failed load
  // avoids showing a false "Working tree clean" state stacked above the real error banner.
  const hasLoadedStatus = controller.status !== null;
  const showCleanState = !controller.error && hasLoadedStatus && !derived.hasChanges;

  if (showCleanState) {
    return (
      <View
        style={styles.cleanStateContainer}
        accessibilityRole="text"
        accessibilityLabel="Working tree is clean. No changes to stage or commit."
      >
        <Ionicons name="checkmark-circle-outline" size={32} color={theme.colors.textMuted} />
        <Text style={styles.cleanStateText}>Working tree clean</Text>
        <Text style={styles.cleanStateSubtext}>No staged or unstaged changes.</Text>
      </View>
    );
  }

  if (!derived.hasChanges) {
    // No changes to render because the status either hasn't loaded successfully yet or the
    // most recent refresh failed; GitScreen's loading spinner / error banner communicates that.
    return null;
  }

  return (
    <>
      <View style={styles.filesHeaderRow}>
        <Text style={[styles.sectionLabel, styles.sectionLabelResetMargin]}>
          Changed files ({derived.changedFiles.length})
        </Text>
      </View>
      <View style={styles.filesCard}>
        <ScrollView
          style={[styles.filesScroll, { maxHeight: derived.filesListMaxHeight }]}
          contentContainerStyle={styles.filesScrollContent}
          showsVerticalScrollIndicator
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          onTouchStart={controller.disableBodyScroll}
          onTouchCancel={controller.enableBodyScroll}
          onTouchEnd={controller.enableBodyScroll}
          onScrollBeginDrag={controller.disableBodyScroll}
          onScrollEndDrag={controller.enableBodyScroll}
          onMomentumScrollEnd={controller.enableBodyScroll}
        >
          {derived.changedFilesWithStats.map((entry) => (
            <GitDiffFileRow
              key={`${entry.code}:${entry.path}`}
              entry={entry}
              controller={controller}
              styles={styles}
            />
          ))}
        </ScrollView>
      </View>

      {derived.truncationNotice ? (
        <Text style={styles.truncationNotice}>{derived.truncationNotice}</Text>
      ) : null}

      {derived.parsedDiff.files.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>Diff summary</Text>
          <View style={styles.diffSummaryRow}>
            <View style={styles.diffSummaryPill}>
              <Text style={styles.diffSummaryLabel}>Files</Text>
              <Text style={styles.diffSummaryValue}>{derived.parsedDiff.files.length}</Text>
            </View>
            <View style={styles.diffSummaryPill}>
              <Text style={styles.diffSummaryLabel}>Added</Text>
              <Text style={[styles.diffSummaryValue, styles.fileAdded]}>
                +{derived.parsedDiff.totalAdditions}
              </Text>
            </View>
            <View style={styles.diffSummaryPill}>
              <Text style={styles.diffSummaryLabel}>Removed</Text>
              <Text style={[styles.diffSummaryValue, styles.fileRemoved]}>
                -{derived.parsedDiff.totalDeletions}
              </Text>
            </View>
          </View>
        </>
      ) : null}

      <Text style={styles.sectionLabel}>Unified diff</Text>
      <View style={styles.diffCard}>
        {derived.parsedDiff.files.length === 0 ? (
          <Text style={styles.emptyFilesText}>
            No patch output for current changes yet (likely untracked files only).
          </Text>
        ) : (
          <>
            <ScrollView
              horizontal
              style={styles.diffTabsScroll}
              contentContainerStyle={styles.diffTabsContent}
              showsHorizontalScrollIndicator={false}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              onTouchStart={controller.disableBodyScroll}
              onTouchCancel={controller.enableBodyScroll}
              onTouchEnd={controller.enableBodyScroll}
            >
              {derived.parsedDiff.files.map((file) => {
                const selected = file.id === controller.activeDiffTabId;
                const commentCount = controller.reviewComments.filter(
                  (comment) => comment.fileId === file.id,
                ).length;
                return (
                  <Pressable
                    key={file.id}
                    onPress={() => controller.selectDiffFile(file.id)}
                    style={({ pressed }) => [
                      styles.diffTab,
                      selected && styles.diffTabActive,
                      pressed && styles.diffTabPressed,
                    ]}
                  >
                    <Text style={styles.diffTabTitle}>{file.displayPath}</Text>
                    <View style={styles.diffTabStats}>
                      <Text style={styles.fileAdded}>+{file.additions}</Text>
                      <Text style={styles.fileRemoved}>-{file.deletions}</Text>
                      {commentCount > 0 ? (
                        <Text style={styles.diffTabCommentCount}>
                          {String(commentCount)} comment{commentCount === 1 ? '' : 's'}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {diffFileForView ? (
              <>
                <View style={styles.diffFileHeader}>
                  <Text style={styles.diffFilePath}>{diffFileForView.displayPath}</Text>
                  <Text style={styles.diffFileStatus}>{diffFileForView.status}</Text>
                </View>

                {controller.showDiffFileSwitching ? (
                  <View style={styles.diffLoadingContainer}>
                    <ActivityIndicator color={theme.colors.textPrimary} size="small" />
                    <Text style={styles.diffLoadingText}>Loading diff…</Text>
                  </View>
                ) : diffFileForView.hunks.length === 0 ? (
                  <Text style={styles.emptyFilesText}>
                    No textual hunks available for this file.
                  </Text>
                ) : (
                  <Animated.View key={diffFileForView.id} entering={FadeIn.duration(200)}>
                    <ScrollView
                      style={[
                        styles.diffVerticalScroll,
                        { maxHeight: derived.diffViewerMaxHeight },
                      ]}
                      contentContainerStyle={styles.diffVerticalContent}
                      showsVerticalScrollIndicator
                      nestedScrollEnabled
                      keyboardShouldPersistTaps="handled"
                      onTouchStart={controller.disableBodyScroll}
                      onTouchCancel={controller.enableBodyScroll}
                      onTouchEnd={controller.enableBodyScroll}
                      onScrollBeginDrag={controller.disableBodyScroll}
                      onScrollEndDrag={controller.enableBodyScroll}
                      onMomentumScrollEnd={controller.enableBodyScroll}
                    >
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator
                        nestedScrollEnabled
                        keyboardShouldPersistTaps="handled"
                        onTouchStart={controller.disableBodyScroll}
                        onTouchCancel={controller.enableBodyScroll}
                        onTouchEnd={controller.enableBodyScroll}
                      >
                        <View style={styles.diffLines}>
                          {diffFileForView.hunks.map((hunk) => (
                            <View
                              key={`${hunk.header}:${hunk.oldStart}:${hunk.newStart}`}
                              style={styles.hunkBlock}
                            >
                              <Text style={styles.hunkHeader}>{hunk.header}</Text>
                              {hunk.lines.map((line, lineIndex) => {
                                const target = createGitReviewTarget(
                                  diffFileForView,
                                  hunk,
                                  line,
                                  lineIndex,
                                );
                                const comment = target
                                  ? controller.reviewComments.find(
                                      (entry) => entry.anchorKey === target.anchorKey,
                                    )
                                  : null;
                                return (
                                  <View key={`${hunk.header}:${lineIndex}`}>
                                    <View
                                      style={[
                                        styles.diffLineRow,
                                        line.kind === 'add' && styles.diffLineRowAdd,
                                        line.kind === 'remove' && styles.diffLineRowRemove,
                                        line.kind === 'meta' && styles.diffLineRowMeta,
                                      ]}
                                    >
                                      <Pressable
                                        onPress={
                                          target
                                            ? () => controller.openReviewComment(target)
                                            : undefined
                                        }
                                        disabled={!target}
                                        hitSlop={
                                          target
                                            ? { top: 11, bottom: 11, left: 8, right: 8 }
                                            : undefined
                                        }
                                        style={({ pressed }) => [
                                          styles.diffCommentButton,
                                          comment && styles.diffCommentButtonActive,
                                          pressed && target && styles.diffCommentButtonPressed,
                                        ]}
                                      >
                                        {target ? (
                                          <Ionicons
                                            name={comment ? 'chatbubble' : 'add-circle-outline'}
                                            size={13}
                                            color={
                                              comment
                                                ? theme.colors.textPrimary
                                                : theme.colors.textMuted
                                            }
                                          />
                                        ) : null}
                                      </Pressable>
                                      <Text style={styles.diffLineNumber}>
                                        {formatDiffLineNumber(line.oldLineNumber)}
                                      </Text>
                                      <Text style={styles.diffLineNumber}>
                                        {formatDiffLineNumber(line.newLineNumber)}
                                      </Text>
                                      <Text
                                        style={[
                                          styles.diffLinePrefix,
                                          line.kind === 'add' && styles.diffLinePrefixAdd,
                                          line.kind === 'remove' && styles.diffLinePrefixRemove,
                                          line.kind === 'meta' && styles.diffLinePrefixMeta,
                                        ]}
                                      >
                                        {line.prefix}
                                      </Text>
                                      <Text selectable style={styles.diffLineText}>
                                        {line.content || ' '}
                                      </Text>
                                    </View>
                                    {comment ? (
                                      <Animated.View
                                        entering={FadeIn.duration(200)}
                                        exiting={FadeOut.duration(120)}
                                        style={styles.inlineReviewComment}
                                      >
                                        <View style={styles.inlineReviewCommentHeader}>
                                          <Text style={styles.inlineReviewCommentAnchor}>
                                            {comment.side} line {String(comment.line)}
                                          </Text>
                                          <View style={styles.inlineReviewCommentActions}>
                                            <Pressable
                                              onPress={() => controller.openReviewComment(comment)}
                                              hitSlop={8}
                                            >
                                              <Text style={styles.inlineReviewCommentAction}>
                                                Edit
                                              </Text>
                                            </Pressable>
                                            <Pressable
                                              onPress={() =>
                                                controller.deleteReviewComment(comment.anchorKey)
                                              }
                                              hitSlop={8}
                                            >
                                              <Text style={styles.inlineReviewCommentDelete}>
                                                Delete
                                              </Text>
                                            </Pressable>
                                          </View>
                                        </View>
                                        <Text style={styles.inlineReviewCommentText}>
                                          {comment.comment}
                                        </Text>
                                      </Animated.View>
                                    ) : null}
                                  </View>
                                );
                              })}
                            </View>
                          ))}
                        </View>
                      </ScrollView>
                    </ScrollView>
                  </Animated.View>
                )}
              </>
            ) : null}
          </>
        )}
      </View>
    </>
  );
}
