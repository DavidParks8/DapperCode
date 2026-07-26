import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { decorativeAccessibilityProps, useModalAccessibilityFocus } from '../accessibility';
import { AppSheet } from '../components/AppSheet';
import type { GitSectionCommonProps } from './gitScreenSectionTypes';

export function GitScreenReviewSection({ controller, styles, theme }: GitSectionCommonProps) {
  const reviewModalFocusRef = useModalAccessibilityFocus(controller.reviewTarget !== null);

  return (
    <>
      {controller.reviewComments.length > 0 ? (
        <View style={styles.reviewTray}>
          <View style={styles.reviewTrayHeader}>
            <View>
              <Text style={styles.reviewTrayTitle}>Inline review</Text>
              <Text style={styles.reviewTraySubtitle}>
                {String(controller.reviewComments.length)} comment
                {controller.reviewComments.length === 1 ? '' : 's'} across{' '}
                {String(new Set(controller.reviewComments.map((comment) => comment.fileId)).size)} file
                {new Set(controller.reviewComments.map((comment) => comment.fileId)).size === 1 ? '' : 's'}
              </Text>
            </View>
            <Pressable onPress={() => controller.setReviewComments([])} hitSlop={6}>
              <Text style={styles.reviewTrayClear}>Clear</Text>
            </Pressable>
          </View>
          {controller.reviewComments.map((comment) => (
            <Pressable
              key={comment.anchorKey}
              onPress={() => {
                controller.selectDiffFile(comment.fileId);
                controller.openReviewComment(comment);
              }}
              style={({ pressed }) => [styles.reviewTrayComment, pressed && styles.reviewTrayCommentPressed]}
            >
              <Text style={styles.reviewTrayCommentAnchor} numberOfLines={1}>
                {comment.path} · {comment.side} {String(comment.line)}
              </Text>
              <Text style={styles.reviewTrayCommentText} numberOfLines={2}>
                {comment.comment}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => void controller.submitReview()}
            disabled={controller.submittingReview}
            style={({ pressed }) => [
              styles.submitReviewButton,
              pressed && styles.actionBtnPressed,
              controller.submittingReview && styles.actionBtnDisabled,
            ]}
          >
            {controller.submittingReview ? (
              <ActivityIndicator size="small" color={theme.colors.accentText} />
            ) : (
              <Ionicons name="paper-plane-outline" size={16} color={theme.colors.accentText} />
            )}
            <Text style={styles.submitReviewButtonText}>
              {controller.submittingReview ? 'Sending review...' : 'Send review to agent'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <AppSheet
        visible={controller.reviewTarget !== null}
        onClose={controller.closeReviewComment}
        accessibilityLabel="Inline comment"
      >
        <View style={styles.reviewModalHeader}>
          <View style={styles.reviewModalTitleBlock}>
            <Text ref={reviewModalFocusRef} accessibilityRole="header" style={styles.reviewModalEyebrow}>
              Inline comment
            </Text>
            <Text style={styles.reviewModalTitle} numberOfLines={2}>
              {controller.reviewTarget
                ? `${controller.reviewTarget.path} · ${controller.reviewTarget.side} ${String(controller.reviewTarget.line)}`
                : ''}
            </Text>
          </View>
          <Pressable
            onPress={controller.closeReviewComment}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close inline comment"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="close"
              size={20}
              color={theme.colors.textMuted}
            />
          </Pressable>
        </View>
        <BottomSheetTextInput
          value={controller.reviewCommentDraft}
          onChangeText={controller.setReviewCommentDraft}
          placeholder="What should the agent change here?"
          placeholderTextColor={theme.colors.textMuted}
          keyboardAppearance={theme.keyboardAppearance}
          autoFocus
          multiline
          textAlignVertical="top"
          style={styles.reviewCommentInput}
          accessibilityLabel="Review comment"
        />
        <View style={styles.reviewModalActions}>
          <Pressable onPress={controller.closeReviewComment} style={styles.reviewModalCancel}>
            <Text style={styles.reviewModalCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={controller.saveReviewComment}
            disabled={!controller.reviewCommentDraft.trim()}
            style={({ pressed }) => [
              styles.reviewModalSave,
              pressed && styles.actionBtnPressed,
              !controller.reviewCommentDraft.trim() && styles.actionBtnDisabled,
            ]}
          >
            <Text style={styles.reviewModalSaveText}>Save comment</Text>
          </Pressable>
        </View>
      </AppSheet>
    </>
  );
}
