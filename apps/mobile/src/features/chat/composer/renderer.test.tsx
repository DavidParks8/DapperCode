import { requireTestValue } from '@shared/testing/requireTestValue';
import React from 'react';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ReduceMotion } from 'react-native-reanimated';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { createTestStore, withAppStore } from '@shell/state/testing';
import type { AppStore } from '@shell/state/types';
import { useMainScreenStyles } from '../styles/useStyles';
import { useMainScreenComposerRenderer } from './renderer';
import type { MainScreenComposerRendererContext } from './renderer';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

const theme = createAppTheme('dark');

function baseContext(
  overrides: Partial<MainScreenComposerRendererContext> = {},
): Omit<MainScreenComposerRendererContext, 'styles' | 'theme'> {
  return {
    activeAgentLabel: 'Codex',
    activityDetail: null,
    attachmentControlsDisabled: false,
    bannerBridgeUiSurfaces: [],
    canCancelQueuedMessage: false,
    canSteerQueuedMessage: false,
    composerAttachments: [],
    composerOverlayInset: 0,
    composerSafeAreaBottomInset: 0,
    dismissBridgeUiSurface: jest.fn(),
    displayedActivity: { tone: 'idle', title: '' },
    draft: '',
    handleBridgeUiAction: jest.fn(),
    handleCancelQueuedMessage: jest.fn(),
    handleComposerFocus: jest.fn(),
    handleResolveApproval: jest.fn(),
    handleSteerQueuedMessage: jest.fn(),
    handleStopTurn: jest.fn(),
    handleSubmit: jest.fn().mockResolvedValue(undefined),
    isLoading: false,
    isTurnLikelyRunning: false,
    isTurnLoading: false,
    loadingAttachmentFileCandidates: false,
    mentionPathSuggestions: [],
    mentionQuery: null,
    oldestQueuedMessage: null,
    oldestQueuedMessageIsPendingSteer: false,
    onOpenBridgeRecoveryGuide: jest.fn(),
    openAttachmentMenu: jest.fn(),
    queuedMessageSteerDisabledReason: null,
    remainingQueuedMessagesCount: 0,
    removeComposerAttachment: jest.fn(),
    selectMentionSuggestion: jest.fn(),
    selectedChat: null,
    selectedThreadRuntimeSnapshot: null,
    setDraft: jest.fn(),
    showBridgeRecoveryBanner: false,
    showFloatingActivity: false,
    showQueuedMessageDock: false,
    showSlashSuggestions: false,
    showingOptimisticQueuedMessage: false,
    slashSuggestions: [],
    slashSuggestionsMaxHeight: 200,
    visibleError: null,
    ...overrides,
  } as unknown as Omit<MainScreenComposerRendererContext, 'styles' | 'theme'>;
}

function Harness({
  context,
  resultRef,
}: {
  context: Omit<MainScreenComposerRendererContext, 'styles' | 'theme'>;
  resultRef: { current: ReturnType<typeof useMainScreenComposerRenderer> | null };
}) {
  const { theme: resolvedTheme, styles } = useMainScreenStyles();
  const fullContext = {
    ...context,
    theme: resolvedTheme,
    styles,
  } as unknown as MainScreenComposerRendererContext;
  resultRef.current = useMainScreenComposerRenderer(fullContext);
  return resultRef.current.renderComposer(false);
}

function render(
  context: Omit<MainScreenComposerRendererContext, 'styles' | 'theme'>,
): ReactTestRenderer {
  const store: AppStore = createTestStore();
  const resultRef: { current: ReturnType<typeof useMainScreenComposerRenderer> | null } = {
    current: null,
  };
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      withAppStore(
        store,
        <AppThemeProvider theme={theme}>
          <Harness context={context} resultRef={resultRef} />
        </AppThemeProvider>,
      ),
    );
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function root(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

describe('mainScreenComposerRenderer suggestion surfaces', () => {
  it('renders slash suggestions with reduce-motion aware entering/exiting animations', () => {
    const enteringSpy = jest.spyOn(
      jest.requireActual('@shared/testing/reanimatedMock').FadeIn,
      'reduceMotion',
    );
    const exitingSpy = jest.spyOn(
      jest.requireActual('@shared/testing/reanimatedMock').FadeOut,
      'reduceMotion',
    );

    const context = baseContext({
      showSlashSuggestions: true,
      slashSuggestions: [
        { name: 'clear', summary: 'Clear the chat', mobileSupported: true, argsHint: undefined },
      ] as unknown as MainScreenComposerRendererContext['slashSuggestions'],
    });
    const tree = render(context);

    expect(enteringSpy).toHaveBeenCalledWith(ReduceMotion.System);
    expect(exitingSpy).toHaveBeenCalledWith(ReduceMotion.System);
    const suggestionText = root(tree).findAll(
      (node) => typeof node.children[0] === 'string' && node.children[0] === '/clear',
    );
    expect(suggestionText.length).toBeGreaterThan(0);

    act(() => tree.unmount());
    enteringSpy.mockRestore();
    exitingSpy.mockRestore();
  });

  it('renders the indexing status while loading mention suggestions', () => {
    const context = baseContext({
      mentionQuery: 'read',
      loadingAttachmentFileCandidates: true,
      mentionPathSuggestions: [],
    });
    const tree = render(context);

    const status = root(tree).findAll(
      (node) => typeof node.children[0] === 'string' && node.children[0] === 'Indexing files…',
    );
    expect(status.length).toBeGreaterThan(0);

    act(() => tree.unmount());
  });

  it('renders mention path suggestions as pressable rows', () => {
    const context = baseContext({
      mentionQuery: 'read',
      loadingAttachmentFileCandidates: false,
      mentionPathSuggestions: ['src/README.md'],
    });
    const tree = render(context);

    const pressableRows = root(tree).findAll((node) => typeof node.props['onPress'] === 'function');
    expect(pressableRows.length).toBeGreaterThan(0);

    act(() => tree.unmount());
  });

  it('renders the bridge recovery banner button with an effective touch target', () => {
    const context = baseContext({ showBridgeRecoveryBanner: true });
    const tree = render(context);

    const button = requireTestValue(
      root(tree).findAll(
        (node) => typeof node.props['hitSlop'] === 'object' && node.props['hitSlop'] !== null,
      )[0],
      'indexed test value',
    );
    expect(button).toBeDefined();
    const hitSlop = button.props['hitSlop'] as { top: number; bottom: number };
    expect(hitSlop.top).toBeGreaterThan(0);
    expect(hitSlop.bottom).toBeGreaterThan(0);

    act(() => tree.unmount());
  });
});
