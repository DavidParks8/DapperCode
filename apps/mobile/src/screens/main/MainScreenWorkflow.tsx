import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Markdown } from '@believer/react-native-markdown-display';
import type { BridgeQueuedMessage } from '../../api/types';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import { hasStructuredPlanCardContent } from './planCardState';
import { useAppTheme } from '../../theme';
import { createStyles, createWorkflowMarkdownStyles } from './mainScreenStyles';
import {
  type ActivePlanState,
  PLAN_IMPLEMENTATION_TITLE,
  PLAN_IMPLEMENTATION_YES,
  PLAN_IMPLEMENTATION_NO,
  renderPlanStatusGlyph,
  queuedMessageStatusLabel,
  stripMarkdownInline,
} from './mainScreenHelpers';

export function WorkflowCard({
  mode,
  plan,
  collapsed,
  scrollMaxHeight,
  actionDisabled,
  onToggleCollapse,
  onImplement,
  onStayInPlanMode,
}: {
  mode: 'plan' | 'approval' | 'execution';
  plan: ActivePlanState | null;
  collapsed: boolean;
  scrollMaxHeight: number;
  actionDisabled: boolean;
  onToggleCollapse: () => void;
  onImplement: () => void;
  onStayInPlanMode: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const workflowMarkdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);
  const hasStructuredPlan = hasStructuredPlanCardContent(plan);
  const hasSteps = (plan?.steps.length ?? 0) > 0;
  const totalStepCount = plan?.steps.length ?? 0;
  const completedStepCount = plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const inProgressStepCount =
    plan?.steps.filter((step) => step.status === 'inProgress').length ?? 0;
  const pendingStepCount = plan?.steps.filter((step) => step.status === 'pending').length ?? 0;
  const activeStep = plan
    ? (plan.steps.find((step) => step.status === 'inProgress') ??
      plan.steps.find((step) => step.status === 'pending') ??
      plan.steps[plan.steps.length - 1] ??
      null)
    : null;
  const collapsedSummaryRaw =
    mode === 'approval'
      ? (activeStep?.step ??
        plan?.explanation?.trim() ??
        'Start coding now or keep refining the plan.')
      : mode === 'execution'
        ? (activeStep?.step ?? plan?.explanation?.trim() ?? '(no execution details yet)')
        : (activeStep?.step ?? plan?.explanation?.trim() ?? '(no steps provided)');
  const collapsedSummary = stripMarkdownInline(collapsedSummaryRaw)
    .replace(/\s*#{1,6}\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isCollapsible = hasStructuredPlan || mode === 'approval';
  const title =
    mode === 'approval' ? PLAN_IMPLEMENTATION_TITLE : mode === 'execution' ? 'Execution' : 'Plan';
  const iconName =
    mode === 'approval'
      ? 'rocket-outline'
      : mode === 'execution'
        ? 'construct-outline'
        : 'map-outline';
  const planProgressSummary =
    totalStepCount > 0
      ? [
          `${String(completedStepCount)}/${String(totalStepCount)} done`,
          inProgressStepCount > 0 ? `${String(inProgressStepCount)} active` : null,
          pendingStepCount > 0 ? `${String(pendingStepCount)} pending` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  if (!hasStructuredPlan && mode !== 'approval') {
    return null;
  }

  const stepListContent = hasSteps ? (
    <View style={styles.planStepsList}>
      {plan?.steps.map((step, index) => (
        <View key={`${plan.turnId}-${index}-${step.step}`} style={styles.planStepRow}>
          <Text
            style={[
              styles.planStepStatus,
              step.status === 'completed'
                ? styles.planStepStatusCompleted
                : step.status === 'inProgress'
                  ? styles.planStepStatusInProgress
                  : styles.planStepStatusPending,
            ]}
          >
            {renderPlanStatusGlyph(step.status)}
          </Text>
          <View style={styles.planStepMarkdownWrap}>
            <Markdown style={workflowMarkdownStyles}>{step.step}</Markdown>
          </View>
        </View>
      ))}
    </View>
  ) : (
    <Text style={styles.planDeltaText}>(no steps provided)</Text>
  );

  const planSections = hasStructuredPlan ? (
    mode === 'execution' ? (
      <>
        <View style={styles.workflowSection}>
          <Text style={styles.workflowSectionEyebrow}>Plan summary</Text>
          {plan?.explanation ? (
            <Markdown style={workflowMarkdownStyles}>{plan.explanation}</Markdown>
          ) : activeStep ? (
            <Markdown style={workflowMarkdownStyles}>{activeStep.step}</Markdown>
          ) : null}
          {planProgressSummary ? (
            <Text style={styles.workflowMetaText}>{planProgressSummary}</Text>
          ) : null}
        </View>
        <View style={styles.workflowSection}>
          <Text style={styles.workflowSectionEyebrow}>Tasks</Text>
          {stepListContent}
        </View>
      </>
    ) : (
      <>
        {plan?.explanation ? (
          <Markdown style={workflowMarkdownStyles}>{plan.explanation}</Markdown>
        ) : null}
        {stepListContent}
      </>
    )
  ) : null;

  const header = isCollapsible ? (
    <Pressable
      style={({ pressed }) => [
        styles.planCardHeader,
        styles.planCardHeaderPressable,
        pressed && styles.modelChipPressed,
      ]}
      onPress={onToggleCollapse}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${collapsedSummary}`}
      accessibilityState={controlAccessibilityState({ expanded: !collapsed })}
    >
      <Ionicons
        {...decorativeAccessibilityProps}
        name={iconName}
        size={14}
        color={theme.colors.textPrimary}
      />
      <View style={styles.planCardHeaderText}>
        <Text style={styles.planCardTitle}>{title}</Text>
        {collapsed ? (
          <Text style={styles.planCardSummary} numberOfLines={1}>
            {collapsedSummary}
          </Text>
        ) : null}
      </View>
      <Ionicons
        {...decorativeAccessibilityProps}
        name={collapsed ? 'chevron-down-outline' : 'chevron-up-outline'}
        size={16}
        color={theme.colors.textMuted}
      />
    </Pressable>
  ) : (
    <View style={styles.planCardHeader}>
      <Ionicons
        {...decorativeAccessibilityProps}
        name={iconName}
        size={14}
        color={theme.colors.textPrimary}
      />
      <View style={styles.planCardHeaderText}>
        <Text style={styles.planCardTitle}>{title}</Text>
        <Text style={styles.planCardSummary} numberOfLines={2}>
          {collapsedSummary}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.planCard, styles.planOverlayCard]}>
      {header}

      {collapsed && isCollapsible ? null : (
        <>
          {planSections ? (
            <ScrollView
              nestedScrollEnabled
              bounces={false}
              style={[styles.workflowScrollViewport, { maxHeight: scrollMaxHeight }]}
              contentContainerStyle={styles.workflowScrollContent}
              showsVerticalScrollIndicator
            >
              {planSections}
            </ScrollView>
          ) : null}

          {mode === 'approval' ? (
            <View style={styles.planPromptOptionsColumn}>
              <Pressable
                onPress={onImplement}
                disabled={actionDisabled}
                style={({ pressed }) => [
                  styles.planPromptOptionButton,
                  actionDisabled && styles.planPromptOptionButtonDisabled,
                  pressed && !actionDisabled && styles.planPromptOptionButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityState={controlAccessibilityState({ disabled: actionDisabled })}
              >
                <Text
                  style={[
                    styles.planPromptOptionTitle,
                    actionDisabled && styles.planPromptOptionTitleDisabled,
                  ]}
                >
                  {PLAN_IMPLEMENTATION_YES}
                </Text>
                <Text
                  style={[
                    styles.planPromptOptionDescription,
                    actionDisabled && styles.planPromptOptionDescriptionDisabled,
                  ]}
                >
                  Switch to Default mode and start coding.
                </Text>
              </Pressable>
              <Pressable
                onPress={onStayInPlanMode}
                disabled={actionDisabled}
                style={({ pressed }) => [
                  styles.planPromptOptionButton,
                  actionDisabled && styles.planPromptOptionButtonDisabled,
                  pressed && !actionDisabled && styles.planPromptOptionButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityState={controlAccessibilityState({ disabled: actionDisabled })}
              >
                <Text
                  style={[
                    styles.planPromptOptionTitle,
                    actionDisabled && styles.planPromptOptionTitleDisabled,
                  ]}
                >
                  {PLAN_IMPLEMENTATION_NO}
                </Text>
                <Text
                  style={[
                    styles.planPromptOptionDescription,
                    actionDisabled && styles.planPromptOptionDescriptionDisabled,
                  ]}
                >
                  Stay in Plan mode and keep refining the approach.
                </Text>
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

export function QueuedMessageDock({
  queuedMessage,
  remainingQueuedMessagesCount,
  pendingSubmission,
  steerEnabled,
  cancelEnabled,
  steeringActive,
  steerPending,
  waitingForToolCalls,
  steeringInFlight,
  steerDisabledReason,
  onCancelQueuedMessage,
  onSteerQueuedMessage,
}: {
  queuedMessage: BridgeQueuedMessage;
  remainingQueuedMessagesCount: number;
  pendingSubmission: boolean;
  steerEnabled: boolean;
  cancelEnabled: boolean;
  steeringActive: boolean;
  steerPending: boolean;
  waitingForToolCalls: boolean;
  steeringInFlight: boolean;
  steerDisabledReason: string | null;
  onCancelQueuedMessage: (messageId: string) => void;
  onSteerQueuedMessage: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.queuedMessageDock} accessibilityLiveRegion="polite">
      <View style={[styles.planCard, styles.planOverlayCard, styles.queuedMessageCard]}>
        <View style={styles.queuedMessageHeader}>
          <View style={styles.queuedMessageHeaderText}>
            <Text style={styles.planCardTitle}>
              {queuedMessageStatusLabel({
                pendingSubmission,
                steeringActive,
                steeringInFlight,
                steerPending,
                waitingForToolCalls,
              })}
            </Text>
            {remainingQueuedMessagesCount > 0 ? (
              <Text style={styles.queuedMessageSummary}>
                {`+${String(remainingQueuedMessagesCount)} more queued`}
              </Text>
            ) : null}
          </View>
          <View style={styles.queuedMessageActions}>
            <Pressable
              onPress={() => onCancelQueuedMessage(queuedMessage.id)}
              disabled={!cancelEnabled}
              style={({ pressed }) => [
                styles.queuedMessageActionButton,
                styles.queuedMessageActionButtonDestructive,
                !cancelEnabled && styles.queuedMessageActionButtonDisabled,
                pressed && cancelEnabled && styles.queuedMessageActionButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Cancel queued message"
              accessibilityState={controlAccessibilityState({ disabled: !cancelEnabled })}
            >
              <Text
                style={[
                  styles.queuedMessageActionLabel,
                  styles.queuedMessageActionLabelDestructive,
                  !cancelEnabled && styles.queuedMessageActionLabelDisabled,
                ]}
              >
                Cancel
              </Text>
            </Pressable>
            {!steerPending ? (
              <Pressable
                onPress={onSteerQueuedMessage}
                disabled={!steerEnabled}
                style={({ pressed }) => [
                  styles.queuedMessageActionButton,
                  !steerEnabled && styles.queuedMessageActionButtonDisabled,
                  pressed && steerEnabled && styles.queuedMessageActionButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  steeringActive ? 'Steering queued message' : 'Steer queued message'
                }
                accessibilityHint={steerDisabledReason ?? undefined}
                accessibilityState={controlAccessibilityState({
                  disabled: !steerEnabled,
                  busy: steeringActive,
                })}
              >
                <Text
                  style={[
                    styles.queuedMessageActionLabel,
                    !steerEnabled && styles.queuedMessageActionLabelDisabled,
                  ]}
                >
                  {steeringActive ? 'Steering…' : 'Steer'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <Text numberOfLines={3} style={styles.queuedMessageBody}>
          {queuedMessage.content}
        </Text>
        {steerDisabledReason ? (
          <Text style={styles.queuedMessageHint}>{steerDisabledReason}</Text>
        ) : null}
      </View>
    </View>
  );
}
