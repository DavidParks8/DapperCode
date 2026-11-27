import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import type { BridgeUiAction, BridgeUiSurface } from '@bridge/types/types';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
} from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import type { BridgeUiActionHandler } from '../approvals/SurfaceRenderers';
import {
  formatCallElapsed,
  phoneCallModel,
  phoneCallStatusLine,
  type HangupState,
  type PhoneCallModel,
} from '../approvals/phoneCallModel';
import { getBridgeUiSurfaceReceivedAt } from '../helpers/bridgeUi';
import { CallTimelineView } from './CallTimelineView';
import { createPhoneCallStageStyles } from './phoneCallStageStyles';
import {
  activityBackground,
  activityColor,
  activityIconName,
  emptyCallTranscriptText,
  useCallElapsedSeconds,
} from './phoneCallVisuals';
import { StageWhisperBar } from './PhoneCallWhisperBar';

export { QUICK_WHISPER_CHIPS } from './PhoneCallWhisperBar';

const FOLLOW_LATEST_SLOP = 28;
const STEER_ACTION: BridgeUiAction = {
  id: 'steer',
  label: 'Whisper',
  style: 'primary',
  dismissesSurface: false,
};

export interface PhoneCallStageContentProps {
  surface: BridgeUiSurface;
  host: 'sheet' | 'split-pane';
  whisperDraft: string;
  onChangeWhisperDraft: (value: string) => void;
  onClose: () => void;
  onAction: BridgeUiActionHandler;
  onDismiss: (surface: BridgeUiSurface) => void;
  /** Shown in sheet mode when a chat tool approval/input needs attention (e.g. async voice tool). */
  hasPendingChatAttention?: boolean;
  onJumpToChatAttention?: () => void;
}

/**
 * Dedicated 3-zone Live Call Stage:
 * 1. Header: callee, live speaking/hold/tool activity, timer, details toggle, and Hang Up.
 * 2. Conversation: two-sided transcript bubbles + system event pills + async tool-activity chips.
 * 3. Whisper bar: quick-steer chips + freeform whisper input routed via `bridge/ui/resolve`.
 */
export function PhoneCallStageContent({
  surface,
  host,
  whisperDraft,
  onChangeWhisperDraft,
  onClose,
  onAction,
  onDismiss,
  hasPendingChatAttention = false,
  onJumpToChatAttention,
}: PhoneCallStageContentProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createPhoneCallStageStyles(theme), [theme]);
  const model = useMemo(() => phoneCallModel(surface), [surface]);
  const elapsed = useCallElapsedSeconds(model, getBridgeUiSurfaceReceivedAt(surface));
  const [hangup, setHangup] = useState<HangupState>('idle');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [whisperState, setWhisperState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const followingLatestRef = useRef(true);
  const isSheet = host === 'sheet';
  const active = model.hangupAction !== null;
  const statusLine = phoneCallStatusLine(model, elapsed, hangup);

  useAccessibilityAnnouncement(
    `${model.calleeDisplay.displayName}: ${active && hangup === 'idle' ? (model.activityLabel ?? model.status) : statusLine}`,
  );

  useEffect(() => {
    if (!model.hangupAction) {
      setHangup('idle');
    }
  }, [model.hangupAction]);

  useEffect(() => {
    if (whisperState !== 'sent') {
      return undefined;
    }
    const timer = setTimeout(() => setWhisperState('idle'), 2_500);
    return () => clearTimeout(timer);
  }, [whisperState]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const nearEnd =
      contentSize.height - contentOffset.y - layoutMeasurement.height < FOLLOW_LATEST_SLOP;
    followingLatestRef.current = nearEnd;
    setShowJumpLatest((current) => (current === !nearEnd ? current : !nearEnd));
  };

  const handleJumpLatest = () => {
    followingLatestRef.current = true;
    setShowJumpLatest(false);
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  const handleHangup = () => {
    if (!model.hangupAction || hangup === 'pending') {
      return;
    }
    void feedback.destructive();
    setHangup('pending');
    const outcome = onAction(surface, model.hangupAction);
    if (outcome instanceof Promise) {
      void outcome.then((ok) => {
        if (!ok) {
          setHangup('failed');
        }
      });
    }
  };

  const sendWhisper = async (rawInstruction: string, clearDraft: boolean) => {
    const instruction = rawInstruction.trim();
    if (!active || !instruction || whisperState === 'sending') {
      return;
    }
    void feedback.selection();
    setWhisperState('sending');
    try {
      const outcome = onAction(surface, STEER_ACTION, { instruction });
      const ok = outcome instanceof Promise ? await outcome : true;
      if (ok) {
        if (clearDraft) {
          onChangeWhisperDraft('');
        }
        setWhisperState('sent');
      } else {
        setWhisperState('failed');
      }
    } catch {
      setWhisperState('failed');
    }
  };

  return (
    <View
      style={[styles.root, isSheet ? styles.rootSheet : styles.rootPane]}
      testID="phone-call-stage"
    >
      <StageHeader
        model={model}
        statusLine={statusLine}
        hangup={hangup}
        isSheet={isSheet}
        detailsOpen={detailsOpen}
        dismissible={surface.dismissible !== false}
        onToggleDetails={() => {
          void feedback.selection();
          setDetailsOpen((current) => !current);
        }}
        onClose={onClose}
        onHangup={handleHangup}
        onDismiss={() => onDismiss(surface)}
        styles={styles}
        theme={theme}
      />

      <StageAttentionBanner
        visible={isSheet && hasPendingChatAttention && Boolean(onJumpToChatAttention)}
        onPress={onJumpToChatAttention}
        styles={styles}
        theme={theme}
      />

      {detailsOpen ? <StageDetailsPanel model={model} isSheet={isSheet} styles={styles} /> : null}

      <View style={[styles.conversationShell, isSheet && styles.conversationShellSheet]}>
        <ScrollView
          ref={scrollRef}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={styles.conversationScroll}
          contentContainerStyle={[
            styles.conversationContent,
            isSheet && styles.conversationContentSheet,
          ]}
          onScroll={handleScroll}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (active && followingLatestRef.current) {
              scrollRef.current?.scrollToEnd({ animated: false });
            }
          }}
          testID="phone-call-stage-timeline-scroll"
        >
          <CallTimelineView
            items={model.timeline}
            emptyText={emptyCallTranscriptText(model.phase)}
            testID="phone-call-stage-timeline"
          />
        </ScrollView>
        {showJumpLatest && model.timeline.length > 0 ? (
          <Pressable
            onPress={handleJumpLatest}
            hitSlop={computeHitSlop({ width: 84, height: 34 })}
            style={({ pressed }) => [styles.jumpLatestPill, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Jump to latest transcript"
            testID="phone-call-stage-jump-latest"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="arrow-down"
              size={14}
              color={theme.colors.textPrimary}
            />
            <Text style={styles.jumpLatestLabel}>Latest</Text>
          </Pressable>
        ) : null}
      </View>

      {active ? (
        <StageWhisperBar
          isSheet={isSheet}
          draft={whisperDraft}
          whisperState={whisperState}
          onChangeDraft={(value) => {
            onChangeWhisperDraft(value);
            if (whisperState === 'failed') {
              setWhisperState('idle');
            }
          }}
          onSubmitDraft={() => void sendWhisper(whisperDraft, true)}
          onQuickWhisper={(instruction) => void sendWhisper(instruction, false)}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

function StageAttentionBanner({
  visible,
  onPress,
  styles,
  theme,
}: {
  visible: boolean;
  onPress?: () => void;
  styles: ReturnType<typeof createPhoneCallStageStyles>;
  theme: AppTheme;
}) {
  if (!visible || !onPress) {
    return null;
  }
  return (
    <View
      style={[styles.attentionBanner, styles.attentionBannerSheet]}
      testID="phone-call-stage-attention-banner"
    >
      <Ionicons
        {...decorativeAccessibilityProps}
        name="alert-circle-outline"
        size={18}
        color={theme.colors.warning}
      />
      <Text style={styles.attentionCopy}>Agent needs your input in chat</Text>
      <Pressable
        onPress={() => {
          void feedback.selection();
          onPress();
        }}
        hitSlop={computeHitSlop({ width: 64, height: 32 })}
        style={({ pressed }) => [styles.attentionAction, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="View chat prompt"
        testID="phone-call-stage-attention-action"
      >
        <Text style={styles.attentionActionLabel}>View</Text>
      </Pressable>
    </View>
  );
}

function StageHeader({
  model,
  statusLine,
  hangup,
  isSheet,
  detailsOpen,
  dismissible,
  onToggleDetails,
  onClose,
  onHangup,
  onDismiss,
  styles,
  theme,
}: {
  model: PhoneCallModel;
  statusLine: string;
  hangup: HangupState;
  isSheet: boolean;
  detailsOpen: boolean;
  dismissible: boolean;
  onToggleDetails: () => void;
  onClose: () => void;
  onHangup: () => void;
  onDismiss: () => void;
  styles: ReturnType<typeof createPhoneCallStageStyles>;
  theme: AppTheme;
}) {
  const accent = activityColor(theme, model.phase, model.activityKind);
  const badgeBg = activityBackground(theme, model.phase, model.activityKind);
  const iconName = activityIconName(model.phase, model.activityKind);
  const hasSecondaryNumber = Boolean(
    model.calleeDisplay.name && model.calleeDisplay.formattedNumber,
  );
  const hitSlop = useMemo(() => computeHitSlop({ width: 36, height: 36 }), []);
  const hangupHitSlop = useMemo(() => computeHitSlop({ width: 40, height: 40 }), []);

  return (
    <View style={[styles.header, isSheet && styles.headerSheet]}>
      <Pressable
        onPress={onClose}
        hitSlop={hitSlop}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Minimize call view"
        testID="phone-call-stage-close"
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={isSheet ? 'chevron-down' : 'close'}
          size={18}
          color={theme.colors.textPrimary}
        />
      </Pressable>

      <View style={styles.headerCopy}>
        <Text style={styles.calleeTitle} numberOfLines={1} ellipsizeMode="middle">
          {model.calleeDisplay.displayName}
        </Text>
        {hasSecondaryNumber ? (
          <Text style={styles.calleeSubline} numberOfLines={1}>
            {model.calleeDisplay.formattedNumber}
          </Text>
        ) : null}
        <View style={styles.statusRow}>
          <View style={[styles.statusBadge, { backgroundColor: badgeBg }]}>
            {model.activityKind === 'running_tool' ? (
              <ActivityIndicator size="small" color={accent} />
            ) : (
              <Ionicons
                {...decorativeAccessibilityProps}
                name={iconName}
                size={12}
                color={accent}
              />
            )}
            <Text
              style={[
                styles.statusText,
                { color: hangup === 'failed' ? theme.colors.error : accent },
              ]}
              numberOfLines={1}
              testID="phone-call-stage-status"
            >
              {statusLine}
            </Text>
          </View>
        </View>
      </View>

      <Pressable
        onPress={onToggleDetails}
        hitSlop={hitSlop}
        style={({ pressed }) => [
          styles.iconButton,
          detailsOpen && styles.iconButtonActive,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Call details"
        accessibilityState={controlAccessibilityState({ expanded: detailsOpen })}
        testID="phone-call-stage-details-toggle"
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name="information-circle-outline"
          size={19}
          color={theme.colors.textPrimary}
        />
      </Pressable>

      {model.hangupAction ? (
        <Pressable
          onPress={onHangup}
          disabled={hangup === 'pending'}
          hitSlop={hangupHitSlop}
          style={({ pressed }) => [
            styles.hangupButton,
            (pressed || hangup === 'pending') && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={model.hangupAction.label}
          accessibilityState={controlAccessibilityState({
            disabled: hangup === 'pending',
            busy: hangup === 'pending',
          })}
          testID="phone-call-stage-hangup"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="call"
            size={18}
            color={theme.colors.white}
            style={styles.hangupGlyph}
          />
        </Pressable>
      ) : dismissible ? (
        <Pressable
          onPress={onDismiss}
          hitSlop={hitSlop}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Dismiss call summary"
          testID="phone-call-stage-dismiss"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="trash-outline"
            size={17}
            color={theme.colors.textMuted}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

function StageDetailsPanel({
  model,
  isSheet,
  styles,
}: {
  model: PhoneCallModel;
  isSheet: boolean;
  styles: ReturnType<typeof createPhoneCallStageStyles>;
}) {
  const settled = model.phase === 'ended' || model.phase === 'failed';
  return (
    <View
      style={[styles.detailsPanel, isSheet && styles.detailsPanelSheet]}
      testID="phone-call-stage-details"
    >
      {model.outcome ? (
        <View style={styles.detailField}>
          <Text style={styles.detailLabel}>{model.outcome.label}</Text>
          <Text style={styles.detailValue}>{model.outcome.value}</Text>
        </View>
      ) : null}
      {model.objective ? (
        <View style={styles.detailField}>
          <Text style={styles.detailLabel}>Objective</Text>
          <Text style={styles.detailValue}>{model.objective}</Text>
        </View>
      ) : null}
      {model.callerIdFormatted ? (
        <View style={styles.detailField}>
          <Text style={styles.detailLabel}>Calling from</Text>
          <Text style={styles.detailValue}>{model.callerIdFormatted}</Text>
        </View>
      ) : null}
      {settled && model.durationSeconds !== null ? (
        <View style={styles.detailField}>
          <Text style={styles.detailLabel}>Duration</Text>
          <Text style={styles.detailValue}>{formatCallElapsed(model.durationSeconds)}</Text>
        </View>
      ) : null}
      {model.details ? (
        <View style={styles.detailField}>
          <Text style={styles.detailLabel}>Technical details</Text>
          <Text style={styles.detailMuted} selectable>
            {model.details}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
