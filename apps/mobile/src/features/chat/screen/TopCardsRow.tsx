import { useAtomValue } from 'jotai';
import { ScrollView, View } from 'react-native';

import {
  useSceneContentInsets,
  useSceneHorizontalInsets,
  useShellLayout,
} from '@shell/layout/useShellLayout';
import { BridgeUiWorkflowCard } from '../approvals/BridgeUiSurface';
import { composerHeightAtom, keyboardInsetAtom, keyboardVisibleAtom } from '../state/composer';
import type { useMainScreenStyles } from '../styles/useStyles';
import { resolveTranscriptHorizontalPadding } from '../transcript/viewChrome';
import { WorkflowCard } from '../workflow/Workflow';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;
type MainScreenTheme = ReturnType<typeof useMainScreenStyles>['theme'];
type MainScreenStyles = ReturnType<typeof useMainScreenStyles>['styles'];

const DEFAULT_HEADER_CHROME_HEIGHT = 112;
const DEFAULT_COMPOSER_HEIGHT = 84;
// Keep over half of the reading viewport unobstructed so page-level transcript scrolling still
// works with stacked workflow cards or on a compact iPhone Duo screen.
const TOP_CARDS_READING_SHARE = 0.45;
const TOP_CARDS_MAX_HEIGHT = 420;
const WORKFLOW_CARD_CHROME_HEIGHT = 84;
const APPROVAL_CARD_CHROME_HEIGHT = 180;
const MIN_INNER_CARD_SCROLL_HEIGHT = 72;

export function computeTopCardsViewportBudget(options: {
  windowHeight: number;
  headerChromeHeight: number;
  bottomReservedHeight: number;
  workflowCardMode: Context['workflowCardMode'];
  cardCount: number;
}): {
  topCardsMaxHeight: number;
  bridgeSurfaceScrollMaxHeight: number | null;
  workflowCardScrollMaxHeight: number | null;
} {
  const headerHeight =
    options.headerChromeHeight > 0 ? options.headerChromeHeight : DEFAULT_HEADER_CHROME_HEIGHT;
  const bottomReserved =
    options.bottomReservedHeight > 0 ? options.bottomReservedHeight : DEFAULT_COMPOSER_HEIGHT;
  const readingHeight = Math.max(0, options.windowHeight - headerHeight - bottomReserved);
  const topCardsMaxHeight = Math.min(
    Math.floor(readingHeight * TOP_CARDS_READING_SHARE),
    TOP_CARDS_MAX_HEIGHT,
  );
  // Avoid competing nested vertical scroll views when multiple cards stack or the viewport is tight.
  if (options.cardCount > 1) {
    return {
      topCardsMaxHeight,
      bridgeSurfaceScrollMaxHeight: null,
      workflowCardScrollMaxHeight: null,
    };
  }
  const bridgeInner = Math.min(topCardsMaxHeight - WORKFLOW_CARD_CHROME_HEIGHT, 360);
  const workflowChrome =
    options.workflowCardMode === 'approval'
      ? APPROVAL_CARD_CHROME_HEIGHT
      : WORKFLOW_CARD_CHROME_HEIGHT;
  const workflowCap = options.workflowCardMode === 'approval' ? 280 : 360;
  const workflowInner = Math.min(topCardsMaxHeight - workflowChrome, workflowCap);
  return {
    topCardsMaxHeight,
    bridgeSurfaceScrollMaxHeight: bridgeInner >= MIN_INNER_CARD_SCROLL_HEIGHT ? bridgeInner : null,
    workflowCardScrollMaxHeight:
      workflowInner >= MIN_INNER_CARD_SCROLL_HEIGHT ? workflowInner : null,
  };
}

export function TopCardsRow(props: {
  context: Context;
  styles: MainScreenStyles;
  theme: MainScreenTheme;
  headerChromeHeight: number;
  sending: boolean;
  creating: boolean;
  stoppingTurn: boolean;
}) {
  const { context, styles, theme, headerChromeHeight, sending, creating, stoppingTurn } = props;
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
  const sceneInsets = useSceneHorizontalInsets();
  const { readable } = useSceneContentInsets();
  const { sidebarMode } = useShellLayout();
  const composerHeight = useAtomValue(composerHeightAtom);
  const keyboardVisible = useAtomValue(keyboardVisibleAtom);
  const keyboardInset = useAtomValue(keyboardInsetAtom);
  const messageColumnInset = resolveTranscriptHorizontalPadding(
    theme.spacing.lg,
    readable,
    sidebarMode !== 'overlay',
  );
  const bottomReservedHeight =
    (composerHeight > 0 ? composerHeight : DEFAULT_COMPOSER_HEIGHT) +
    (keyboardVisible ? keyboardInset : 0) +
    theme.spacing.sm;
  const cardCount = workflowBridgeUiSurfaces.length + (workflowCardMode ? 1 : 0);
  const budget = computeTopCardsViewportBudget({
    windowHeight,
    headerChromeHeight,
    bottomReservedHeight,
    workflowCardMode,
    cardCount,
  });

  return (
    <View style={[styles.topCardsRow, sceneInsets]} testID="chat-top-cards-container">
      <ScrollView
        testID="chat-top-cards"
        nestedScrollEnabled
        bounces={false}
        alwaysBounceVertical={false}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        style={[styles.topCardsScroll, { maxHeight: budget.topCardsMaxHeight }]}
        contentContainerStyle={[
          styles.topCardsRowContent,
          { paddingHorizontal: messageColumnInset },
        ]}
      >
        {workflowBridgeUiSurfaces.map((surface, index) => (
          <BridgeUiWorkflowCard
            key={surface.id}
            surface={surface}
            scrollMaxHeight={budget.bridgeSurfaceScrollMaxHeight}
            defaultCollapsed={index < workflowBridgeUiSurfaces.length - 1}
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
            scrollMaxHeight={budget.workflowCardScrollMaxHeight}
            actionDisabled={sending || creating || stoppingTurn}
            onToggleCollapse={toggleSelectedPlanPanel}
            onImplement={() => void implementPlan()}
            onStayInPlanMode={stayInPlanMode}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
