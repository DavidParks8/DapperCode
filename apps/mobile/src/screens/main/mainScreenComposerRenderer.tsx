import { pendingApprovalAtom, stoppingTurnAtom } from '../../state/mainScreen/turn';
import {
  composerHeightAtom,
  keyboardVisibleAtom,
  queueActionItemIdAtom,
  queueActionKindAtom,
} from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo, type ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
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

type ComposerPendingApproval = ComponentProps<typeof ApprovalBanner>['approval'];
type BridgeRecoveryBannerButtonHitSlop = NonNullable<ComponentProps<typeof Pressable>['hitSlop']>;

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
  const handleOverlayLayout = (event: LayoutChangeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    setComposerHeight((previous) => (previous === nextHeight ? previous : nextHeight));
  };

  const renderComposer = (overlay: boolean) => (
    <View
      onLayout={overlay ? handleOverlayLayout : undefined}
      style={[
        styles.composerContainer,
        overlay ? styles.composerContainerOverlay : null,
        overlay ? { bottom: composerOverlayInset } : null,
        !overlay && !keyboardVisible ? styles.composerContainerResting : null,
      ]}
    >
      <ComposerErrorAlert visibleError={visibleError} styles={styles} />
      <BridgeRecoveryBannerView
        showBridgeRecoveryBanner={showBridgeRecoveryBanner}
        onOpenBridgeRecoveryGuide={onOpenBridgeRecoveryGuide}
        bridgeRecoveryBannerButtonHitSlop={bridgeRecoveryBannerButtonHitSlop}
        styles={styles}
        theme={theme}
      />
      <BridgeUiBannerList
        showBridgeRecoveryBanner={showBridgeRecoveryBanner}
        bannerBridgeUiSurfaces={bannerBridgeUiSurfaces}
        handleBridgeUiAction={handleBridgeUiAction}
        dismissBridgeUiSurface={dismissBridgeUiSurface}
      />
      <PendingApprovalView pendingApproval={pendingApproval} onResolve={handleResolveApproval} />
      <QueuedMessageDockView
        showQueuedMessageDock={showQueuedMessageDock}
        oldestQueuedMessage={oldestQueuedMessage}
        remainingQueuedMessagesCount={remainingQueuedMessagesCount}
        showingOptimisticQueuedMessage={showingOptimisticQueuedMessage}
        canSteerQueuedMessage={canSteerQueuedMessage}
        canCancelQueuedMessage={canCancelQueuedMessage}
        queueActionItemId={queueActionItemId}
        queueActionKind={queueActionKind}
        oldestQueuedMessageIsPendingSteer={oldestQueuedMessageIsPendingSteer}
        selectedThreadRuntimeSnapshot={selectedThreadRuntimeSnapshot}
        queuedMessageSteerDisabledReason={queuedMessageSteerDisabledReason}
        handleCancelQueuedMessage={handleCancelQueuedMessage}
        handleSteerQueuedMessage={handleSteerQueuedMessage}
      />
      <SlashSuggestionsView
        showSlashSuggestions={showSlashSuggestions}
        slashSuggestions={slashSuggestions}
        slashSuggestionsMaxHeight={slashSuggestionsMaxHeight}
        setDraft={setDraft}
        styles={styles}
      />
      <MentionSuggestionsView
        showSlashSuggestions={showSlashSuggestions}
        mentionQuery={mentionQuery}
        loadingAttachmentFileCandidates={loadingAttachmentFileCandidates}
        mentionPathSuggestions={mentionPathSuggestions}
        slashSuggestionsMaxHeight={slashSuggestionsMaxHeight}
        selectMentionSuggestion={selectMentionSuggestion}
        styles={styles}
      />
      <FloatingActivityDockView
        overlay={overlay}
        showFloatingActivity={showFloatingActivity}
        displayedActivity={displayedActivity}
        activityDetail={activityDetail}
        styles={styles}
      />
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

function ComposerErrorAlert({
  visibleError,
  styles,
}: {
  visibleError: string | null;
  styles: MainScreenComposerRendererContext['styles'];
}) {
  if (!visibleError) {
    return null;
  }

  return (
    <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.errorText}>
      {visibleError}
    </Text>
  );
}

function BridgeRecoveryBannerView({
  showBridgeRecoveryBanner,
  onOpenBridgeRecoveryGuide,
  bridgeRecoveryBannerButtonHitSlop,
  styles,
  theme,
}: {
  showBridgeRecoveryBanner: boolean;
  onOpenBridgeRecoveryGuide: MainScreenComposerRendererContext['onOpenBridgeRecoveryGuide'];
  bridgeRecoveryBannerButtonHitSlop: BridgeRecoveryBannerButtonHitSlop;
  styles: MainScreenComposerRendererContext['styles'];
  theme: MainScreenComposerRendererContext['theme'];
}) {
  if (!showBridgeRecoveryBanner) {
    return null;
  }

  return (
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
  );
}

function BridgeUiBannerList({
  showBridgeRecoveryBanner,
  bannerBridgeUiSurfaces,
  handleBridgeUiAction,
  dismissBridgeUiSurface,
}: {
  showBridgeRecoveryBanner: boolean;
  bannerBridgeUiSurfaces: MainScreenComposerRendererContext['bannerBridgeUiSurfaces'];
  handleBridgeUiAction: MainScreenComposerRendererContext['handleBridgeUiAction'];
  dismissBridgeUiSurface: MainScreenComposerRendererContext['dismissBridgeUiSurface'];
}) {
  if (showBridgeRecoveryBanner) {
    return null;
  }

  return (
    <>
      {bannerBridgeUiSurfaces.map((surface) => (
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
      ))}
    </>
  );
}

function PendingApprovalView({
  pendingApproval,
  onResolve,
}: {
  pendingApproval: ComposerPendingApproval | null;
  onResolve: MainScreenComposerRendererContext['handleResolveApproval'];
}) {
  return pendingApproval ? (
    <ApprovalBanner approval={pendingApproval} onResolve={onResolve} />
  ) : null;
}

function QueuedMessageDockView({
  showQueuedMessageDock,
  oldestQueuedMessage,
  remainingQueuedMessagesCount,
  showingOptimisticQueuedMessage,
  canSteerQueuedMessage,
  canCancelQueuedMessage,
  queueActionItemId,
  queueActionKind,
  oldestQueuedMessageIsPendingSteer,
  selectedThreadRuntimeSnapshot,
  queuedMessageSteerDisabledReason,
  handleCancelQueuedMessage,
  handleSteerQueuedMessage,
}: {
  showQueuedMessageDock: boolean;
  oldestQueuedMessage: MainScreenComposerRendererContext['oldestQueuedMessage'];
  remainingQueuedMessagesCount: MainScreenComposerRendererContext['remainingQueuedMessagesCount'];
  showingOptimisticQueuedMessage: MainScreenComposerRendererContext['showingOptimisticQueuedMessage'];
  canSteerQueuedMessage: MainScreenComposerRendererContext['canSteerQueuedMessage'];
  canCancelQueuedMessage: MainScreenComposerRendererContext['canCancelQueuedMessage'];
  queueActionItemId: string | null;
  queueActionKind: string | null;
  oldestQueuedMessageIsPendingSteer: MainScreenComposerRendererContext['oldestQueuedMessageIsPendingSteer'];
  selectedThreadRuntimeSnapshot: MainScreenComposerRendererContext['selectedThreadRuntimeSnapshot'];
  queuedMessageSteerDisabledReason: MainScreenComposerRendererContext['queuedMessageSteerDisabledReason'];
  handleCancelQueuedMessage: MainScreenComposerRendererContext['handleCancelQueuedMessage'];
  handleSteerQueuedMessage: MainScreenComposerRendererContext['handleSteerQueuedMessage'];
}) {
  if (!showQueuedMessageDock || !oldestQueuedMessage) {
    return null;
  }

  return (
    <QueuedMessageDock
      queuedMessage={oldestQueuedMessage}
      remainingQueuedMessagesCount={remainingQueuedMessagesCount}
      pendingSubmission={showingOptimisticQueuedMessage}
      steerEnabled={canSteerQueuedMessage}
      cancelEnabled={canCancelQueuedMessage}
      steeringActive={queueActionKind === 'steer' && queueActionItemId === oldestQueuedMessage.id}
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
  );
}

function SlashSuggestionsView({
  showSlashSuggestions,
  slashSuggestions,
  slashSuggestionsMaxHeight,
  setDraft,
  styles,
}: {
  showSlashSuggestions: boolean;
  slashSuggestions: MainScreenComposerRendererContext['slashSuggestions'];
  slashSuggestionsMaxHeight: number;
  setDraft: MainScreenComposerRendererContext['setDraft'];
  styles: MainScreenComposerRendererContext['styles'];
}) {
  if (!showSlashSuggestions) {
    return null;
  }

  return (
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
  );
}

function MentionSuggestionsView({
  showSlashSuggestions,
  mentionQuery,
  loadingAttachmentFileCandidates,
  mentionPathSuggestions,
  slashSuggestionsMaxHeight,
  selectMentionSuggestion,
  styles,
}: {
  showSlashSuggestions: boolean;
  mentionQuery: MainScreenComposerRendererContext['mentionQuery'];
  loadingAttachmentFileCandidates: boolean;
  mentionPathSuggestions: MainScreenComposerRendererContext['mentionPathSuggestions'];
  slashSuggestionsMaxHeight: number;
  selectMentionSuggestion: MainScreenComposerRendererContext['selectMentionSuggestion'];
  styles: MainScreenComposerRendererContext['styles'];
}) {
  if (showSlashSuggestions || mentionQuery === null) {
    return null;
  }
  if (loadingAttachmentFileCandidates && mentionPathSuggestions.length === 0) {
    return (
      <InlineMentionStatus
        accessibilityLiveRegion="polite"
        styles={styles}
        text="Indexing files…"
      />
    );
  }
  if (mentionPathSuggestions.length > 0) {
    return (
      <MentionSuggestionList
        mentionPathSuggestions={mentionPathSuggestions}
        slashSuggestionsMaxHeight={slashSuggestionsMaxHeight}
        selectMentionSuggestion={selectMentionSuggestion}
        styles={styles}
      />
    );
  }
  return mentionQuery.trim().length > 0 ? (
    <InlineMentionStatus styles={styles} text="No matching files found." />
  ) : null;
}

function InlineMentionStatus({
  accessibilityLiveRegion,
  styles,
  text,
}: {
  accessibilityLiveRegion?: 'polite';
  styles: MainScreenComposerRendererContext['styles'];
  text: string;
}) {
  return (
    <Animated.View
      entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
      style={styles.inlineMentionStatus}
    >
      <Text accessibilityLiveRegion={accessibilityLiveRegion} style={styles.workspaceModalLoading}>
        {text}
      </Text>
    </Animated.View>
  );
}

function MentionSuggestionList({
  mentionPathSuggestions,
  slashSuggestionsMaxHeight,
  selectMentionSuggestion,
  styles,
}: {
  mentionPathSuggestions: MainScreenComposerRendererContext['mentionPathSuggestions'];
  slashSuggestionsMaxHeight: number;
  selectMentionSuggestion: MainScreenComposerRendererContext['selectMentionSuggestion'];
  styles: MainScreenComposerRendererContext['styles'];
}) {
  return (
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
  );
}

function FloatingActivityDockView({
  overlay,
  showFloatingActivity,
  displayedActivity,
  activityDetail,
  styles,
}: {
  overlay: boolean;
  showFloatingActivity: boolean;
  displayedActivity: MainScreenComposerRendererContext['displayedActivity'];
  activityDetail: MainScreenComposerRendererContext['activityDetail'];
  styles: MainScreenComposerRendererContext['styles'];
}) {
  if (!overlay || !showFloatingActivity) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.activityDock}>
      <ActivityBar
        title={displayedActivity.title}
        detail={activityDetail}
        tone={displayedActivity.tone}
      />
    </View>
  );
}
