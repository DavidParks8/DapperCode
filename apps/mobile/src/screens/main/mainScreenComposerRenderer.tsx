import { pendingApprovalAtom, stoppingTurnAtom } from '../../state/mainScreen/turn';
import {
  composerHeightAtom,
  keyboardVisibleAtom,
  queueActionItemIdAtom,
  queueActionKindAtom,
} from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { ActivityBar } from '../../components/ActivityBar';
import { ApprovalBanner } from '../../components/ApprovalBanner';
import { BridgeUiBanner } from '../../components/BridgeUiSurface';
import { ChatInput } from '../../components/ChatInput';
import { decorativeAccessibilityProps } from '../../accessibility';
import { computeHitSlop } from '../../components/touchTarget';
import { motionDuration } from '../../components/motion';
import { toPathBasename } from './mainScreenHelpers';
import { QueuedMessageDock } from './MainScreenWorkflow';
import type {
  MainScreenWorkflowQueueStateContext,
  MainScreenWorkflowQueueStateResult,
} from './mainScreenWorkflowQueueState';

export type MainScreenComposerRendererContext = MainScreenWorkflowQueueStateContext &
  MainScreenWorkflowQueueStateResult;

export function useMainScreenComposerRenderer(context: MainScreenComposerRendererContext) {
  const {
    activeAgentLabel,
    activityDetail,
    attachmentControlsDisabled,
    bannerBridgeUiSurfaces,
    canCancelQueuedMessage,
    canSteerQueuedMessage,
    composerAttachments,
    composerOverlayInset,
    composerSafeAreaBottomInset,
    dismissBridgeUiSurface,
    displayedActivity,
    draft,
    handleBridgeUiAction,
    handleCancelQueuedMessage,
    handleComposerFocus,
    handleResolveApproval,
    handleSteerQueuedMessage,
    handleStopTurn,
    handleSubmit,
    isLoading,
    isTurnLikelyRunning,
    isTurnLoading,
    loadingAttachmentFileCandidates,
    mentionPathSuggestions,
    mentionQuery,
    oldestQueuedMessage,
    oldestQueuedMessageIsPendingSteer,
    onOpenBridgeRecoveryGuide,
    openAttachmentMenu,
    queuedMessageSteerDisabledReason,
    remainingQueuedMessagesCount,
    removeComposerAttachment,
    selectMentionSuggestion,
    selectedChat,
    selectedThreadRuntimeSnapshot,
    setDraft,
    showBridgeRecoveryBanner,
    showFloatingActivity,
    showQueuedMessageDock,
    showSlashSuggestions,
    showingOptimisticQueuedMessage,
    slashSuggestions,
    slashSuggestionsMaxHeight,
    styles,
    theme,
    visibleError,
  } = context;
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const stoppingTurn = useAtomValue(stoppingTurnAtom);
  const keyboardVisible = useAtomValue(keyboardVisibleAtom);
  const queueActionItemId = useAtomValue(queueActionItemIdAtom);
  const queueActionKind = useAtomValue(queueActionKindAtom);
  const setComposerHeight = useSetAtom(composerHeightAtom);
  const bridgeRecoveryBannerButtonHitSlop = useMemo(
    () => computeHitSlop({ width: 160, height: 32 }),
    [],
  );

  const renderComposer = (overlay: boolean) => (
    <View
      onLayout={
        overlay
          ? (event) => {
              const nextHeight = Math.ceil(event.nativeEvent.layout.height);
              setComposerHeight((previous) => (previous === nextHeight ? previous : nextHeight));
            }
          : undefined
      }
      style={[
        styles.composerContainer,
        overlay ? styles.composerContainerOverlay : null,
        overlay ? { bottom: composerOverlayInset } : null,
        !overlay && !keyboardVisible ? styles.composerContainerResting : null,
      ]}
    >
      {visibleError ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.errorText}
        >
          {visibleError}
        </Text>
      ) : null}
      {showBridgeRecoveryBanner ? (
        <Animated.View
          entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
          style={styles.bridgeRecoveryBanner}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <View style={styles.bridgeRecoveryBannerTopRow}>
            <View style={styles.bridgeRecoveryBannerIconWrap}>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="warning-outline"
                size={16}
                color={theme.colors.warning}
              />
            </View>
            <View style={styles.bridgeRecoveryBannerCopy}>
              <Text style={styles.bridgeRecoveryBannerTitle}>Bridge disconnected</Text>
              <Text style={styles.bridgeRecoveryBannerBody}>
                Start the bridge on your computer to continue. The app will reconnect automatically.
              </Text>
            </View>
          </View>
          {onOpenBridgeRecoveryGuide ? (
            <Pressable
              onPress={onOpenBridgeRecoveryGuide}
              hitSlop={bridgeRecoveryBannerButtonHitSlop}
              style={({ pressed }) => [
                styles.bridgeRecoveryBannerButton,
                pressed && styles.bridgeRecoveryBannerButtonPressed,
              ]}
            >
              <Text style={styles.bridgeRecoveryBannerButtonText}>How to start bridge</Text>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}
      {!showBridgeRecoveryBanner
        ? bannerBridgeUiSurfaces.map((surface) => (
            <BridgeUiBanner
              key={surface.id}
              surface={surface}
              onAction={(nextSurface, action) => {
                void handleBridgeUiAction(nextSurface, action);
              }}
              onDismiss={(nextSurface) => {
                void dismissBridgeUiSurface(nextSurface);
              }}
            />
          ))
        : null}
      {pendingApproval ? (
        <ApprovalBanner approval={pendingApproval} onResolve={handleResolveApproval} />
      ) : null}
      {showQueuedMessageDock && oldestQueuedMessage ? (
        <QueuedMessageDock
          queuedMessage={oldestQueuedMessage}
          remainingQueuedMessagesCount={remainingQueuedMessagesCount}
          pendingSubmission={showingOptimisticQueuedMessage}
          steerEnabled={canSteerQueuedMessage}
          cancelEnabled={canCancelQueuedMessage}
          steeringActive={
            queueActionKind === 'steer' && queueActionItemId === oldestQueuedMessage.id
          }
          steerPending={oldestQueuedMessageIsPendingSteer}
          waitingForToolCalls={selectedThreadRuntimeSnapshot?.waitingForToolCalls === true}
          steeringInFlight={selectedThreadRuntimeSnapshot?.steeringInFlight === true}
          steerDisabledReason={queuedMessageSteerDisabledReason}
          onCancelQueuedMessage={(messageId) => {
            void handleCancelQueuedMessage(messageId);
          }}
          onSteerQueuedMessage={() => {
            void handleSteerQueuedMessage();
          }}
        />
      ) : null}
      {showSlashSuggestions ? (
        <Animated.ScrollView
          entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
          style={[styles.slashSuggestions, { maxHeight: slashSuggestionsMaxHeight }]}
          contentContainerStyle={styles.slashSuggestionsContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {slashSuggestions.map((command, index) => {
            const suffix = command.argsHint ? ` ${command.argsHint}` : '';
            return (
              <Pressable
                key={`${command.name}-${String(index)}`}
                onPress={() => setDraft(`/${command.name}${command.argsHint ? ' ' : ''}`)}
                style={({ pressed }) => [
                  styles.slashSuggestionItem,
                  index === slashSuggestions.length - 1 && styles.slashSuggestionItemLast,
                  pressed && styles.slashSuggestionItemPressed,
                ]}
              >
                <Text style={styles.slashSuggestionTitle}>{`/${command.name}${suffix}`}</Text>
                <Text style={styles.slashSuggestionSummary} numberOfLines={1}>
                  {command.mobileSupported ? command.summary : `${command.summary} · CLI only`}
                </Text>
              </Pressable>
            );
          })}
        </Animated.ScrollView>
      ) : null}
      {!showSlashSuggestions && mentionQuery !== null ? (
        loadingAttachmentFileCandidates && mentionPathSuggestions.length === 0 ? (
          <Animated.View
            entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
            style={styles.inlineMentionStatus}
          >
            <Text accessibilityLiveRegion="polite" style={styles.workspaceModalLoading}>
              Indexing files…
            </Text>
          </Animated.View>
        ) : mentionPathSuggestions.length > 0 ? (
          <Animated.ScrollView
            entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
            style={[styles.slashSuggestions, { maxHeight: slashSuggestionsMaxHeight }]}
            contentContainerStyle={styles.slashSuggestionsContent}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {mentionPathSuggestions.map((path, index) => (
              <Pressable
                key={`${path}-${String(index)}`}
                onPress={() => selectMentionSuggestion(path)}
                style={({ pressed }) => [
                  styles.slashSuggestionItem,
                  index === mentionPathSuggestions.length - 1 && styles.slashSuggestionItemLast,
                  pressed && styles.slashSuggestionItemPressed,
                ]}
              >
                <Text style={styles.slashSuggestionTitle} numberOfLines={1}>
                  {toPathBasename(path)}
                </Text>
                <Text style={styles.slashSuggestionSummary} numberOfLines={1}>
                  {path}
                </Text>
              </Pressable>
            ))}
          </Animated.ScrollView>
        ) : mentionQuery.trim().length > 0 ? (
          <Animated.View
            entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
            style={styles.inlineMentionStatus}
          >
            <Text style={styles.workspaceModalLoading}>No matching files found.</Text>
          </Animated.View>
        ) : null
      ) : null}
      {overlay && showFloatingActivity ? (
        <View pointerEvents="none" style={styles.activityDock}>
          <ActivityBar
            title={displayedActivity.title}
            detail={activityDetail}
            tone={displayedActivity.tone}
          />
        </View>
      ) : null}
      <ChatInput
        value={draft}
        onChangeText={setDraft}
        onFocus={handleComposerFocus}
        onSubmit={() => void handleSubmit()}
        onStop={() => handleStopTurn()}
        showStopButton={isTurnLoading || isTurnLikelyRunning || stoppingTurn}
        isStopping={stoppingTurn}
        onAttachPress={openAttachmentMenu}
        attachDisabled={attachmentControlsDisabled}
        attachments={composerAttachments}
        onRemoveAttachment={removeComposerAttachment}
        isLoading={isLoading}
        placeholder={selectedChat ? 'Reply...' : `Message ${activeAgentLabel}...`}
        safeAreaBottomInset={composerSafeAreaBottomInset}
        keyboardVisible={keyboardVisible}
        reserveFooterSpace={false}
        footer={null}
      />
    </View>
  );

  return {
    renderComposer,
  };
}

export type MainScreenComposerRendererResult = ReturnType<typeof useMainScreenComposerRenderer>;
