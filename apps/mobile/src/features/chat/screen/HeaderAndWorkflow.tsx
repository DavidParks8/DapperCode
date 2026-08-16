import { useMainScreenStyles } from '../styles/useStyles';
import { creatingAtom, sendingAtom, stoppingTurnAtom } from '../state/turn';
import { useAtomValue } from 'jotai';
import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { BridgeUiWorkflowCard } from '../approvals/BridgeUiSurface';
import { ChatHeader } from './ChatHeader';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { AppSheet } from '@shared/ui/AppSheet';
import { WorkflowCard } from '../workflow/Workflow';
import { SESSION_META_CHIP_HEIGHT } from '../styles/sessionMetaChip';
import type { SessionTokenTotals } from '../state/runtime';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;
type MainScreenTheme = ReturnType<typeof useMainScreenStyles>['theme'];
type MainScreenStyles = ReturnType<typeof useMainScreenStyles>['styles'];
type TokenSheetStyles = {
  tokenSheetHeader: StyleProp<ViewStyle>;
  tokenSheetTitle: StyleProp<TextStyle>;
  tokenSheetSubtitle: StyleProp<TextStyle>;
  tokenSheetGroup: StyleProp<ViewStyle>;
  tokenSheetGroupHeader: StyleProp<ViewStyle>;
  tokenSheetGroupTitleRow: StyleProp<ViewStyle>;
  tokenSheetGroupTitle: StyleProp<TextStyle>;
  tokenSheetGroupSubtitle: StyleProp<TextStyle>;
  tokenSheetSubtotal: StyleProp<TextStyle>;
  tokenSheetRow: StyleProp<ViewStyle>;
  tokenSheetRowLabel: StyleProp<TextStyle>;
  tokenSheetRowValue: StyleProp<TextStyle>;
  tokenSheetFooter: StyleProp<ViewStyle>;
  tokenSheetFooterLabel: StyleProp<TextStyle>;
  tokenSheetFooterValue: StyleProp<TextStyle>;
  tokenSheetCost: StyleProp<TextStyle>;
};

// Chips are dense, dynamically-sized labels in a scrollable row (28pt tall); the estimated
// The selector buttons share the composer's 48pt control height. Horizontal slop remains capped so
// labels narrower than the representative width cannot steal taps from neighboring buttons.
// The selector row sits directly under the header row, so a tall visual box left a dead gap
// between the two. The box is compact and `computeHitSlop` restores the effective touch target;
// the vertical cap stops that slop from reaching up into the header buttons above it.
const SESSION_META_CHIP_VISIBLE_SIZE = { width: 60, height: SESSION_META_CHIP_HEIGHT };
const SESSION_META_CHIP_HIT_SLOP_OPTIONS = { maxHorizontal: 3, maxVertical: 8 };

function handleSessionMetaChipPress(action: () => void | Promise<void>): void {
  void feedback.selection();
  void action();
}

function computeWorkflowCardScrollMaxHeight(
  windowHeight: number,
  workflowCardMode: Context['workflowCardMode'],
) {
  if (workflowCardMode === 'approval') {
    return Math.max(176, Math.min(Math.floor(windowHeight * 0.34), 280));
  }

  return Math.max(176, Math.min(Math.floor(windowHeight * 0.4), 360));
}

function formatScaledTokenValue(scaled: number): string {
  if (scaled >= 100) {
    return `${Math.round(scaled)}`;
  }
  return `${Number(scaled.toFixed(1))}`;
}

export function formatCompactTokenCount(tokenCount: number): string {
  if (tokenCount >= 1_000_000) {
    return `${formatScaledTokenValue(tokenCount / 1_000_000)}m tk`;
  }
  if (tokenCount >= 1_000) {
    return `${formatScaledTokenValue(tokenCount / 1_000)}k tk`;
  }
  return `${tokenCount.toLocaleString()} tk`;
}

function SessionMetaChip(props: {
  styles: MainScreenStyles;
  theme: MainScreenTheme;
  baseStyle: StyleProp<ViewStyle>;
  enabledStyle?: StyleProp<ViewStyle>;
  disabledStyle?: StyleProp<ViewStyle>;
  label: string;
  displayText: string;
  iconName: ComponentProps<typeof Ionicons>['name'];
  iconColor?: string;
  textStyle?: StyleProp<TextStyle>;
  accessibilityRole: 'button' | 'switch';
  accessibilityState?: { checked?: boolean; disabled?: boolean };
  hitSlop: { top: number; bottom: number; left: number; right: number };
  onPress: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const {
    styles,
    theme,
    baseStyle,
    enabledStyle,
    disabledStyle,
    label,
    displayText,
    iconName,
    iconColor,
    textStyle,
    accessibilityRole,
    accessibilityState,
    hitSlop,
    onPress,
    disabled,
  } = props;

  return (
    <Pressable
      style={({ pressed }) => [
        baseStyle,
        enabledStyle,
        pressed && styles.modelChipPressed,
        disabled && disabledStyle,
      ]}
      onPress={() => handleSessionMetaChipPress(onPress)}
      hitSlop={hitSlop}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
    >
      <Ionicons
        {...decorativeAccessibilityProps}
        name={iconName}
        size={12}
        color={iconColor ?? theme.colors.textPrimary}
      />
      <Text style={[styles.modelChipText, textStyle]} numberOfLines={1}>
        {displayText}
      </Text>
    </Pressable>
  );
}

function SessionMetaRow(props: {
  context: Context;
  styles: MainScreenStyles;
  theme: MainScreenTheme;
  hitSlop: { top: number; bottom: number; left: number; right: number };
  tokenTotals: SessionTokenTotals | null;
  onOpenTokenSheet: () => void;
}) {
  const { context, styles, theme, hitSlop, tokenTotals, onOpenTokenSheet } = props;
  const {
    selectedChat,
    readyAgents,
    activeAgentLabel,
    openAgentModal,
    modelOptions,
    openModelModal,
    activeModelLabel,
    activeModelEffortOptions,
    openEffortModal,
    activeEffortLabel,
    openCollaborationModeMenu,
    collaborationModeLabel,
    showAgentThreadChip,
    openAgentThreadSelector,
    agentThreadChipLabel,
    supportsFastMode,
    fastModeEnabled,
    fastModeControlDisabled,
    toggleFastMode,
  } = context;
  // The agent is only selectable before a session exists; an open chat is bound to the agent that
  // created it.
  const showAgentChip = !selectedChat && readyAgents.length > 1;

  return (
    <View style={styles.sessionMetaRow} testID="session-meta-row">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.sessionMetaRowContent}
        testID="session-meta-selectors"
      >
        {showAgentChip ? (
          <SessionMetaChip
            styles={styles}
            theme={theme}
            baseStyle={styles.modelChip}
            label={`Agent, ${activeAgentLabel}`}
            displayText={activeAgentLabel}
            iconName="layers-outline"
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={openAgentModal}
          />
        ) : null}
        {modelOptions.length > 0 ? (
          <SessionMetaChip
            styles={styles}
            theme={theme}
            baseStyle={styles.modelChip}
            label={`Model, ${activeModelLabel}`}
            displayText={activeModelLabel}
            iconName="sparkles-outline"
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={openModelModal}
          />
        ) : null}
        {activeModelEffortOptions.length > 0 ? (
          <SessionMetaChip
            styles={styles}
            theme={theme}
            baseStyle={styles.modelChip}
            label={`Thinking level, ${activeEffortLabel}`}
            displayText={activeEffortLabel}
            iconName="pulse-outline"
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={openEffortModal}
          />
        ) : null}
        <SessionMetaChip
          styles={styles}
          theme={theme}
          baseStyle={styles.modeChip}
          label={`Agent mode, ${collaborationModeLabel}`}
          displayText={collaborationModeLabel}
          iconName="map-outline"
          accessibilityRole="button"
          hitSlop={hitSlop}
          onPress={openCollaborationModeMenu}
        />
        {showAgentThreadChip ? (
          <SessionMetaChip
            styles={styles}
            theme={theme}
            baseStyle={styles.modeChip}
            label={agentThreadChipLabel}
            displayText={agentThreadChipLabel}
            iconName="people-outline"
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={() => {
              void openAgentThreadSelector();
            }}
          />
        ) : null}
        {supportsFastMode ? (
          <SessionMetaChip
            styles={styles}
            theme={theme}
            baseStyle={styles.fastChip}
            enabledStyle={fastModeEnabled && styles.fastChipEnabled}
            disabledStyle={styles.sessionMetaChipDisabled}
            label="Fast mode"
            displayText="Fast"
            iconName={fastModeEnabled ? 'flash' : 'flash-outline'}
            iconColor={theme.colors.textPrimary}
            textStyle={fastModeEnabled && styles.fastChipTextEnabled}
            accessibilityRole="switch"
            accessibilityState={{ checked: fastModeEnabled, disabled: fastModeControlDisabled }}
            hitSlop={hitSlop}
            disabled={fastModeControlDisabled}
            onPress={toggleFastMode}
          />
        ) : null}
        {tokenTotals ? (
          <SessionMetaChip
            styles={styles}
            theme={theme}
            baseStyle={styles.tokenUsageChip}
            label={`Token usage, ${tokenTotals.totalTokens.toLocaleString()} tokens this session`}
            displayText={formatCompactTokenCount(tokenTotals.totalTokens)}
            iconName="receipt-outline"
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={onOpenTokenSheet}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function TopCardsRow(props: {
  context: Context;
  styles: MainScreenStyles;
  sending: boolean;
  creating: boolean;
  stoppingTurn: boolean;
}) {
  const { context, styles, sending, creating, stoppingTurn } = props;
  const {
    workflowBridgeUiSurfaces,
    windowHeight,
    handleBridgeUiAction,
    dismissBridgeUiSurface,
    workflowCardMode,
    selectedThreadPlan,
    planPanelCollapsed,
    toggleSelectedPlanPanel,
    implementPlan,
    stayInPlanMode,
  } = context;
  const workflowCardScrollMaxHeight = computeWorkflowCardScrollMaxHeight(
    windowHeight,
    workflowCardMode,
  );

  return (
    <View style={styles.topCardsRow}>
      {workflowBridgeUiSurfaces.map((surface) => (
        <BridgeUiWorkflowCard
          key={surface.id}
          surface={surface}
          scrollMaxHeight={Math.max(176, Math.min(Math.floor(windowHeight * 0.4), 360))}
          onAction={(nextSurface, action) => {
            void handleBridgeUiAction(nextSurface, action);
          }}
          onDismiss={(nextSurface) => {
            void dismissBridgeUiSurface(nextSurface);
          }}
        />
      ))}
      {workflowCardMode ? (
        <WorkflowCard
          mode={workflowCardMode}
          plan={selectedThreadPlan}
          collapsed={planPanelCollapsed}
          scrollMaxHeight={workflowCardScrollMaxHeight}
          actionDisabled={sending || creating || stoppingTurn}
          onToggleCollapse={toggleSelectedPlanPanel}
          onImplement={() => void implementPlan()}
          onStayInPlanMode={stayInPlanMode}
        />
      ) : null}
    </View>
  );
}

function TokenSheetGroup(props: {
  title: string;
  subtitle: string;
  subtotal: number;
  rows: Array<{ label: string; value: number }>;
  styles: TokenSheetStyles;
}) {
  const { title, subtitle, subtotal, rows, styles } = props;
  return (
    <View style={styles.tokenSheetGroup}>
      <View style={styles.tokenSheetGroupHeader}>
        <View style={styles.tokenSheetGroupTitleRow}>
          <Text style={styles.tokenSheetGroupTitle}>{title}</Text>
          <Text style={styles.tokenSheetSubtotal} testID={`token-${title.toLowerCase()}-subtotal`}>
            {subtotal.toLocaleString()}
          </Text>
        </View>
        <Text style={styles.tokenSheetGroupSubtitle}>{subtitle}</Text>
      </View>
      {rows.map((row) => (
        <View key={row.label} style={styles.tokenSheetRow}>
          <Text style={styles.tokenSheetRowLabel}>{row.label}</Text>
          <Text style={styles.tokenSheetRowValue}>{row.value.toLocaleString()}</Text>
        </View>
      ))}
    </View>
  );
}

function SessionTokenSheet(props: {
  visible: boolean;
  onClose: () => void;
  tokenTotals: SessionTokenTotals;
  cost: string | null | undefined;
  styles: MainScreenStyles;
}) {
  const { visible, onClose, tokenTotals, cost, styles } = props;
  const sentRows = [
    { label: 'Fresh input', value: tokenTotals.inputTokens },
    ...(tokenTotals.cachedReadTokens === null
      ? []
      : [{ label: 'Cache read', value: tokenTotals.cachedReadTokens }]),
    ...(tokenTotals.cachedWriteTokens === null
      ? []
      : [{ label: 'Cache write', value: tokenTotals.cachedWriteTokens }]),
  ];
  const receivedRows = [
    { label: 'Visible output', value: tokenTotals.outputTokens },
    ...(tokenTotals.reasoningTokens === null
      ? []
      : [{ label: 'Reasoning', value: tokenTotals.reasoningTokens }]),
  ];
  const sentSubtotal = sentRows.reduce((sum, row) => sum + row.value, 0);
  const receivedSubtotal = receivedRows.reduce((sum, row) => sum + row.value, 0);
  const turnLabel = `${tokenTotals.turns.toLocaleString()} ${
    tokenTotals.turns === 1 ? 'turn' : 'turns'
  }`;

  return (
    <AppSheet visible={visible} onClose={onClose} accessibilityLabel="Session tokens">
      <View style={styles.tokenSheetHeader}>
        <Text style={styles.tokenSheetTitle}>Session tokens</Text>
        <Text style={styles.tokenSheetSubtitle}>{turnLabel}</Text>
      </View>
      <TokenSheetGroup
        title="Sent"
        subtitle="Prompt, context and cache traffic"
        subtotal={sentSubtotal}
        rows={sentRows}
        styles={styles}
      />
      <TokenSheetGroup
        title="Received"
        subtitle="Everything the model generated"
        subtotal={receivedSubtotal}
        rows={receivedRows}
        styles={styles}
      />
      <View style={styles.tokenSheetFooter}>
        <Text style={styles.tokenSheetFooterLabel}>Total tokens</Text>
        <Text style={styles.tokenSheetFooterValue}>{tokenTotals.totalTokens.toLocaleString()}</Text>
      </View>
      {cost ? <Text style={styles.tokenSheetCost}>Session cost {cost}</Text> : null}
    </AppSheet>
  );
}

export function MainScreenHeaderAndWorkflow({ context }: { context: Context }) {
  const {
    onOpenDrawer,
    headerTitle,
    activeAgent,
    selectedChat,
    openTitleEditor,
    handleOpenGit,
    isOpeningChat,
    showTopCardsRow,
  } = context;
  const { theme, styles } = useMainScreenStyles();
  const sending = useAtomValue(sendingAtom);
  const creating = useAtomValue(creatingAtom);
  const stoppingTurn = useAtomValue(stoppingTurnAtom);
  const [tokenSheetVisible, setTokenSheetVisible] = useState(false);
  const sessionMetaChipHitSlop = useMemo(
    () => computeHitSlop(SESSION_META_CHIP_VISIBLE_SIZE, SESSION_META_CHIP_HIT_SLOP_OPTIONS),
    [],
  );
  // The compose screen carries the same session controls, so the chip row is the one place they
  // live in both states. Only the opening placeholder has nothing to configure.
  const showSessionMetaRow = !isOpeningChat;
  const tokenTotals =
    context.selectedThreadRuntimeSnapshot?.tokenTotals ?? selectedChat?.tokenTotals ?? null;

  return (
    <>
      <GlassSurface
        role="chrome"
        style={styles.topChromeGlass}
        testID="chat-top-chrome-glass-surface"
      >
        <ChatHeader
          onOpenDrawer={onOpenDrawer}
          title={headerTitle}
          agent={activeAgent}
          onRenameTitle={selectedChat ? openTitleEditor : undefined}
          embeddedInGlass
          rightIconName={selectedChat ? 'git-branch-outline' : undefined}
          onRightActionPress={selectedChat ? handleOpenGit : undefined}
        />
        {showSessionMetaRow ? (
          <SessionMetaRow
            context={context}
            styles={styles}
            theme={theme}
            hitSlop={sessionMetaChipHitSlop}
            tokenTotals={tokenTotals}
            onOpenTokenSheet={() => setTokenSheetVisible(true)}
          />
        ) : null}
      </GlassSurface>
      {tokenTotals ? (
        <SessionTokenSheet
          visible={tokenSheetVisible}
          onClose={() => setTokenSheetVisible(false)}
          tokenTotals={tokenTotals}
          cost={selectedChat?.acpUsage?.cost}
          styles={styles}
        />
      ) : null}
      {showTopCardsRow ? (
        <TopCardsRow
          context={context}
          styles={styles}
          sending={sending}
          creating={creating}
          stoppingTurn={stoppingTurn}
        />
      ) : null}
    </>
  );
}
