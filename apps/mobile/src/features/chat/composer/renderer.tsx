import { pendingApprovalAtom, stoppingTurnAtom } from '../state/turn';
import {
  composerHeightAtom,
  keyboardVisibleAtom,
  queueActionItemIdAtom,
  queueActionKindAtom,
} from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo, type ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { ApprovalBanner } from '../approvals/ApprovalBanner';
import { BridgeUiBanner } from '../approvals/BridgeUiSurface';
import { ChatInput } from './ChatInput';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { motion } from '@shared/theme';
import { QueuedMessageDockView } from './QueuedMessageDockView';
import { ScheduledPromptDock } from '../workflow/ScheduledPromptDock';
import type {
  MainScreenWorkflowQueueStateContext,
  MainScreenWorkflowQueueStateResult,
} from '../workflow/queueState';

export type MainScreenComposerRendererContext = MainScreenWorkflowQueueStateContext &
  MainScreenWorkflowQueueStateResult;

type ComposerPendingApproval = ComponentProps<typeof ApprovalBanner>['approval'];
type BridgeRecoveryBannerButtonHitSlop = NonNullable<ComponentProps<typeof Pressable>['hitSlop']>;

export function useMainScreenComposerRenderer(context: MainScreenComposerRendererContext) {
  const {
    activeAgentLabel,
    attachmentControlsDisabled,
    attachmentController,
    bannerBridgeUiSurfaces,
    canCancelQueuedMessage,
    canEditQueuedMessage,
    canSteerQueuedMessage,
    composerAttachments,
    composerOverlayInset,
    composerSafeAreaBottomInset,
    dismissBridgeUiSurface,
    draft,
    editingQueuedMessage,
    handleBridgeUiAction,
    handleCancelQueuedMessage,
    handleCancelQueuedMessageEdit,
    handleComposerFocus,
    handleEditQueuedMessage,
    handleResolveApproval,
    handleSteerQueuedMessage,
    handleStopTurn,
    handleSubmit,
    isLoading,
    isTurnLikelyRunning,
    isTurnLoading,
    oldestQueuedMessage,
    oldestQueuedMessageIsPendingSteer,
    onOpenBridgeRecoveryGuide,
    openAttachmentMenu,
    queuedMessageSteerDisabledReason,
    remainingQueuedMessagesCount,
    removeComposerAttachment,
    selectedChat,
    selectedScheduledPrompts,
    selectedThreadRuntimeSnapshot,
    setDraft,
    showBridgeRecoveryBanner,
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
  const submitDisabled =
    context.uploadingAttachment ||
    context.hasFailedAttachmentUploads ||
    queueActionKind === 'editStart' ||
    queueActionKind === 'editCommit' ||
    queueActionKind === 'editCancel';
  const pasteDisabled = editingQueuedMessage || queueActionKind === 'editStart';

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
      <ScheduledPromptDock scheduledPrompts={selectedScheduledPrompts} />
      <QueuedMessageDockView
        showQueuedMessageDock={showQueuedMessageDock}
        oldestQueuedMessage={oldestQueuedMessage}
        remainingQueuedMessagesCount={remainingQueuedMessagesCount}
        showingOptimisticQueuedMessage={showingOptimisticQueuedMessage}
        canSteerQueuedMessage={canSteerQueuedMessage}
        canCancelQueuedMessage={canCancelQueuedMessage}
        canEditQueuedMessage={
          canEditQueuedMessage &&
          !context.uploadingAttachment &&
          !context.hasFailedAttachmentUploads
        }
        queueActionItemId={queueActionItemId}
        queueActionKind={queueActionKind}
        oldestQueuedMessageIsPendingSteer={oldestQueuedMessageIsPendingSteer}
        editingQueuedMessage={editingQueuedMessage}
        selectedThreadRuntimeSnapshot={selectedThreadRuntimeSnapshot}
        queuedMessageSteerDisabledReason={queuedMessageSteerDisabledReason}
        handleCancelQueuedMessage={handleCancelQueuedMessage}
        handleCancelQueuedMessageEdit={handleCancelQueuedMessageEdit}
        handleEditQueuedMessage={handleEditQueuedMessage}
        handleSteerQueuedMessage={handleSteerQueuedMessage}
      />
      <SlashSuggestionsView
        showSlashSuggestions={showSlashSuggestions}
        slashSuggestions={slashSuggestions}
        slashSuggestionsMaxHeight={slashSuggestionsMaxHeight}
        setDraft={setDraft}
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
        pasteScopeKey={attachmentController.pasteScopeKey}
        onPasteImage={({ nativeEvent }) => {
          void attachmentController.pasteImage(nativeEvent, !pasteDisabled);
        }}
        onPasteBusy={({ nativeEvent }) => {
          if (!pasteDisabled) {
            attachmentController.setPasteBusy(nativeEvent);
          }
        }}
        onPasteError={({ nativeEvent }) => {
          if (!pasteDisabled) {
            attachmentController.pasteError(nativeEvent);
          }
        }}
        attachDisabled={attachmentControlsDisabled || pasteDisabled}
        attachments={composerAttachments}
        onRemoveAttachment={removeComposerAttachment}
        isLoading={isLoading}
        isUploading={context.uploadingAttachment}
        submitLabel={editingQueuedMessage ? 'Save queued message' : undefined}
        submitHint={editingQueuedMessage ? 'Saves changes to the queued message' : undefined}
        submitDisabled={submitDisabled}
        placeholder={
          editingQueuedMessage
            ? 'Edit queued message...'
            : selectedChat
              ? 'Reply...'
              : `Message ${activeAgentLabel}...`
        }
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
      entering={FadeIn.duration(motion.duration.routine).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.immediate).reduceMotion(ReduceMotion.System)}
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
      entering={FadeIn.duration(motion.duration.routine).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.immediate).reduceMotion(ReduceMotion.System)}
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
