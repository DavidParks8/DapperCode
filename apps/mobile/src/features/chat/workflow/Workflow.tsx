import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { BridgeQueuedMessage } from '@bridge/types/types';
import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { hasStructuredPlanCardContent } from '../plan/cardState';
import { useAppTheme } from '@shared/theme';
import { createStyles, createWorkflowMarkdownStyles } from '../styles/styles';
import {
  type ActivePlanState,
  PLAN_IMPLEMENTATION_TITLE,
  PLAN_IMPLEMENTATION_YES,
  PLAN_IMPLEMENTATION_NO,
  renderPlanStatusGlyph,
  queuedMessageStatusLabel,
  stripMarkdownInline,
} from '../helpers/helpers';

type WorkflowCardMode = 'plan' | 'approval' | 'execution';

interface WorkflowCardProps {
  mode: 'plan' | 'approval' | 'execution';
  plan: ActivePlanState | null;
  collapsed: boolean;
  scrollMaxHeight: number;
  actionDisabled: boolean;
  onToggleCollapse: () => void;
  onImplement: () => void;
  onStayInPlanMode: () => void;
}

type IconName = ComponentProps<typeof Ionicons>['name'];

const WORKFLOW_CARD_COPY: Record<
  WorkflowCardMode,
  { title: string; iconName: IconName; emptySummary: string }
> = {
  plan: { title: 'Plan', iconName: 'map-outline', emptySummary: '(no steps provided)' },
  approval: {
    title: PLAN_IMPLEMENTATION_TITLE,
    iconName: 'rocket-outline',
    emptySummary: 'Start coding now or keep refining the plan.',
  },
  execution: {
    title: 'Execution',
    iconName: 'construct-outline',
    emptySummary: '(no execution details yet)',
  },
};

function resolveActivePlanStep(
  plan: ActivePlanState | null,
): ActivePlanState['steps'][number] | null {
  return plan
    ? (plan.steps.find((step) => step.status === 'inProgress') ??
        plan.steps.find((step) => step.status === 'pending') ??
        plan.steps[plan.steps.length - 1] ??
        null)
    : null;
}

function normalizeCollapsedSummary(summary: string): string {
  return stripMarkdownInline(summary)
    .replace(/\s*#{1,6}\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCollapsedSummary(
  mode: WorkflowCardMode,
  plan: ActivePlanState | null,
  activeStep: ActivePlanState['steps'][number] | null,
): string {
  return normalizeCollapsedSummary(
    activeStep?.step ?? plan?.explanation?.trim() ?? WORKFLOW_CARD_COPY[mode].emptySummary,
  );
}

function buildPlanProgressSummary(plan: ActivePlanState | null): string | null {
  const steps = plan?.steps ?? [];
  if (steps.length === 0) {
    return null;
  }

  const completedStepCount = steps.filter((step) => step.status === 'completed').length;
  const inProgressStepCount = steps.filter((step) => step.status === 'inProgress').length;
  const pendingStepCount = steps.filter((step) => step.status === 'pending').length;

  return [
    `${String(completedStepCount)}/${String(steps.length)} done`,
    inProgressStepCount > 0 ? `${String(inProgressStepCount)} active` : null,
    pendingStepCount > 0 ? `${String(pendingStepCount)} pending` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function stepStatusStyle(
  styles: ReturnType<typeof createStyles>,
  status: ActivePlanState['steps'][number]['status'],
) {
  const statusStyles = {
    completed: styles.planStepStatusCompleted,
    inProgress: styles.planStepStatusInProgress,
    pending: styles.planStepStatusPending,
  } as const;
  return statusStyles[status];
}

function WorkflowPlanSteps({
  plan,
  styles,
  workflowMarkdownStyles,
}: {
  plan: ActivePlanState | null;
  styles: ReturnType<typeof createStyles>;
  workflowMarkdownStyles: ReturnType<typeof createWorkflowMarkdownStyles>;
}) {
  const steps = plan?.steps ?? [];
  if (steps.length === 0) {
    return <Text style={styles.planDeltaText}>(no steps provided)</Text>;
  }
  const turnId = plan?.turnId ?? 'plan';

  return (
    <View style={styles.planStepsList}>
      {steps.map((step, index) => (
        <View key={`${turnId}-${index}-${step.step}`} style={styles.planStepRow}>
          <Text style={[styles.planStepStatus, stepStatusStyle(styles, step.status)]}>
            {renderPlanStatusGlyph(step.status)}
          </Text>
          <View style={styles.planStepMarkdownWrap}>
            <Markdown style={workflowMarkdownStyles}>{step.step}</Markdown>
          </View>
        </View>
      ))}
    </View>
  );
}

function WorkflowPlanSections({
  mode,
  plan,
  activeStep,
  planProgressSummary,
  styles,
  workflowMarkdownStyles,
}: {
  mode: WorkflowCardMode;
  plan: ActivePlanState | null;
  activeStep: ActivePlanState['steps'][number] | null;
  planProgressSummary: string | null;
  styles: ReturnType<typeof createStyles>;
  workflowMarkdownStyles: ReturnType<typeof createWorkflowMarkdownStyles>;
}) {
  return mode === 'execution' ? (
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
        <WorkflowPlanSteps
          plan={plan}
          styles={styles}
          workflowMarkdownStyles={workflowMarkdownStyles}
        />
      </View>
    </>
  ) : (
    <>
      {plan?.explanation ? (
        <Markdown style={workflowMarkdownStyles}>{plan.explanation}</Markdown>
      ) : null}
      <WorkflowPlanSteps
        plan={plan}
        styles={styles}
        workflowMarkdownStyles={workflowMarkdownStyles}
      />
    </>
  );
}

function WorkflowCardHeader({
  collapsed,
  collapsedSummary,
  iconName,
  isCollapsible,
  onToggleCollapse,
  title,
  styles,
  theme,
}: {
  collapsed: boolean;
  collapsedSummary: string;
  iconName: IconName;
  isCollapsible: boolean;
  onToggleCollapse: () => void;
  title: string;
  styles: ReturnType<typeof createStyles>;
  theme: ReturnType<typeof useAppTheme>;
}) {
  if (isCollapsible) {
    return (
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
    );
  }

  return (
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
}

function WorkflowActionButton({
  actionDisabled,
  onPress,
  title,
  description,
  styles,
}: {
  actionDisabled: boolean;
  onPress: () => void;
  title: string;
  description: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
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
        {title}
      </Text>
      <Text
        style={[
          styles.planPromptOptionDescription,
          actionDisabled && styles.planPromptOptionDescriptionDisabled,
        ]}
      >
        {description}
      </Text>
    </Pressable>
  );
}

function WorkflowApprovalActions({
  actionDisabled,
  onImplement,
  onStayInPlanMode,
  styles,
}: {
  actionDisabled: boolean;
  onImplement: () => void;
  onStayInPlanMode: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.planPromptOptionsColumn}>
      <WorkflowActionButton
        actionDisabled={actionDisabled}
        onPress={onImplement}
        title={PLAN_IMPLEMENTATION_YES}
        description="Switch to Default mode and start coding."
        styles={styles}
      />
      <WorkflowActionButton
        actionDisabled={actionDisabled}
        onPress={onStayInPlanMode}
        title={PLAN_IMPLEMENTATION_NO}
        description="Stay in Plan mode and keep refining the approach."
        styles={styles}
      />
    </View>
  );
}

function WorkflowCardBody({
  collapsed,
  isCollapsible,
  scrollMaxHeight,
  mode,
  planSections,
  actionDisabled,
  onImplement,
  onStayInPlanMode,
  styles,
}: {
  collapsed: boolean;
  isCollapsible: boolean;
  scrollMaxHeight: number;
  mode: WorkflowCardMode;
  planSections: ReactNode;
  actionDisabled: boolean;
  onImplement: () => void;
  onStayInPlanMode: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  if (collapsed && isCollapsible) {
    return null;
  }

  return (
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
        <WorkflowApprovalActions
          actionDisabled={actionDisabled}
          onImplement={onImplement}
          onStayInPlanMode={onStayInPlanMode}
          styles={styles}
        />
      ) : null}
    </>
  );
}

export function WorkflowCard({
  mode,
  plan,
  collapsed,
  scrollMaxHeight,
  actionDisabled,
  onToggleCollapse,
  onImplement,
  onStayInPlanMode,
}: WorkflowCardProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const workflowMarkdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);
  const hasStructuredPlan = hasStructuredPlanCardContent(plan);
  const activeStep = resolveActivePlanStep(plan);
  const collapsedSummary = buildCollapsedSummary(mode, plan, activeStep);
  const isCollapsible = hasStructuredPlan || mode === 'approval';
  const { title, iconName } = WORKFLOW_CARD_COPY[mode];
  const planProgressSummary = buildPlanProgressSummary(plan);

  if (!hasStructuredPlan && mode !== 'approval') {
    return null;
  }
  const planSections = hasStructuredPlan ? (
    <WorkflowPlanSections
      mode={mode}
      plan={plan}
      activeStep={activeStep}
      planProgressSummary={planProgressSummary}
      styles={styles}
      workflowMarkdownStyles={workflowMarkdownStyles}
    />
  ) : null;

  return (
    <View style={[styles.planCard, styles.planOverlayCard]}>
      <WorkflowCardHeader
        collapsed={collapsed}
        collapsedSummary={collapsedSummary}
        iconName={iconName}
        isCollapsible={isCollapsible}
        onToggleCollapse={onToggleCollapse}
        title={title}
        styles={styles}
        theme={theme}
      />
      <WorkflowCardBody
        collapsed={collapsed}
        isCollapsible={isCollapsible}
        scrollMaxHeight={scrollMaxHeight}
        mode={mode}
        planSections={planSections}
        actionDisabled={actionDisabled}
        onImplement={onImplement}
        onStayInPlanMode={onStayInPlanMode}
        styles={styles}
      />
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
