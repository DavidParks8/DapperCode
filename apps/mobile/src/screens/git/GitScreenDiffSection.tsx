import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import type { GitReviewTarget } from './gitDiffReview';
import { createGitReviewTarget } from './gitDiffReview';
import { formatDiffLineNumber, formatStatusCode } from './gitScreenUtils';
import type { GitSectionCommonProps } from './gitScreenSectionTypes';

export function GitScreenDiffSection({ controller, styles, theme }: GitSectionCommonProps) {
  const { derived, diffFileForView } = controller;

  if (!derived.hasChanges) {
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
            <View key={`${entry.code}:${entry.path}`} style={styles.fileRow}>
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
                    disabled={
                      controller.loading ||
                      controller.committing ||
                      controller.pushing ||
                      controller.stagingAll ||
                      controller.unstagingAll ||
                      controller.stagingPath === entry.stagePath ||
                      controller.unstagingPath === entry.stagePath
                    }
                    style={({ pressed }) => [
                      styles.fileActionBtn,
                      styles.fileActionBtnStage,
                      pressed && styles.fileActionBtnPressed,
                      (controller.loading ||
                        controller.committing ||
                        controller.pushing ||
                        controller.stagingAll ||
                        controller.unstagingAll ||
                        controller.stagingPath === entry.stagePath ||
                        controller.unstagingPath === entry.stagePath) &&
                        styles.fileActionBtnDisabled,
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
                    disabled={
                      controller.loading ||
                      controller.committing ||
                      controller.pushing ||
                      controller.stagingAll ||
                      controller.unstagingAll ||
                      controller.unstagingPath === entry.stagePath ||
                      controller.stagingPath === entry.stagePath
                    }
                    style={({ pressed }) => [
                      styles.fileActionBtn,
                      styles.fileActionBtnUnstage,
                      pressed && styles.fileActionBtnPressed,
                      (controller.loading ||
                        controller.committing ||
                        controller.pushing ||
                        controller.stagingAll ||
                        controller.unstagingAll ||
                        controller.unstagingPath === entry.stagePath ||
                        controller.stagingPath === entry.stagePath) &&
                        styles.fileActionBtnDisabled,
                    ]}
                  >
                    <Text style={styles.fileActionText}>
                      {controller.unstagingPath === entry.stagePath ? 'Unstaging...' : 'Unstage'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </ScrollView>
      </View>

      {derived.truncationNotice ? <Text style={styles.errorText}>{derived.truncationNotice}</Text> : null}

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
              <Text style={[styles.diffSummaryValue, styles.fileAdded]}>+{derived.parsedDiff.totalAdditions}</Text>
            </View>
            <View style={styles.diffSummaryPill}>
              <Text style={styles.diffSummaryLabel}>Removed</Text>
              <Text style={[styles.diffSummaryValue, styles.fileRemoved]}>-{derived.parsedDiff.totalDeletions}</Text>
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
                  (comment) => comment.fileId === file.id
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
                  <Text style={styles.emptyFilesText}>No textual hunks available for this file.</Text>
                ) : (
                  <ScrollView
                    style={[styles.diffVerticalScroll, { maxHeight: derived.diffViewerMaxHeight }]}
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
                              const target = createGitReviewTarget(diffFileForView, hunk, line, lineIndex);
                              const comment = target
                                ? controller.reviewComments.find((entry) => entry.anchorKey === target.anchorKey)
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
                                      onPress={target ? () => controller.openReviewComment(target as GitReviewTarget) : undefined}
                                      disabled={!target}
                                      hitSlop={4}
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
                                          color={comment ? theme.colors.textPrimary : theme.colors.textMuted}
                                        />
                                      ) : null}
                                    </Pressable>
                                    <Text style={styles.diffLineNumber}>{formatDiffLineNumber(line.oldLineNumber)}</Text>
                                    <Text style={styles.diffLineNumber}>{formatDiffLineNumber(line.newLineNumber)}</Text>
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
                                    <View style={styles.inlineReviewComment}>
                                      <View style={styles.inlineReviewCommentHeader}>
                                        <Text style={styles.inlineReviewCommentAnchor}>
                                          {comment.side} line {String(comment.line)}
                                        </Text>
                                        <View style={styles.inlineReviewCommentActions}>
                                          <Pressable onPress={() => controller.openReviewComment(comment)}>
                                            <Text style={styles.inlineReviewCommentAction}>Edit</Text>
                                          </Pressable>
                                          <Pressable onPress={() => controller.deleteReviewComment(comment.anchorKey)}>
                                            <Text style={styles.inlineReviewCommentDelete}>Delete</Text>
                                          </Pressable>
                                        </View>
                                      </View>
                                      <Text style={styles.inlineReviewCommentText}>{comment.comment}</Text>
                                    </View>
                                  ) : null}
                                </View>
                              );
                            })}
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  </ScrollView>
                )}
              </>
            ) : null}
          </>
        )}
      </View>
    </>
  );
}
