import { requireTestValue } from '@shared/testing/requireTestValue';
import React from 'react';
import { StyleSheet } from 'react-native';
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
    canEditQueuedMessage: false,
    canSteerQueuedMessage: false,
    composerAttachments: [],
    composerOverlayInset: 0,
    composerSafeAreaBottomInset: 0,
    dismissBridgeUiSurface: jest.fn(),
    displayedActivity: { tone: 'idle', title: '' },
    draft: '',
    editingQueuedMessage: false,
    handleBridgeUiAction: jest.fn(),
    handleCancelQueuedMessage: jest.fn(),
    handleCancelQueuedMessageEdit: jest.fn(),
    handleComposerFocus: jest.fn(),
    handleEditQueuedMessage: jest.fn(),
    handleResolveApproval: jest.fn(),
    handleSteerQueuedMessage: jest.fn(),
    handleStopTurn: jest.fn(),
    handleSubmit: jest.fn().mockResolvedValue(undefined),
    isLoading: false,
    isTurnLikelyRunning: false,
    isTurnLoading: false,
    oldestQueuedMessage: null,
    oldestQueuedMessageIsPendingSteer: false,
    onOpenBridgeRecoveryGuide: jest.fn(),
    openAttachmentMenu: jest.fn(),
    queuedMessageSteerDisabledReason: null,
    remainingQueuedMessagesCount: 0,
    removeComposerAttachment: jest.fn(),
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
  overlay = false,
  resultRef,
}: {
  context: Omit<MainScreenComposerRendererContext, 'styles' | 'theme'>;
  overlay?: boolean;
  resultRef: { current: ReturnType<typeof useMainScreenComposerRenderer> | null };
}) {
  const { theme: resolvedTheme, styles } = useMainScreenStyles();
  const fullContext = {
    ...context,
    theme: resolvedTheme,
    styles,
  } as unknown as MainScreenComposerRendererContext;
  resultRef.current = useMainScreenComposerRenderer(fullContext);
  return resultRef.current.renderComposer(overlay);
}

function render(
  context: Omit<MainScreenComposerRendererContext, 'styles' | 'theme'>,
  overlay = false,
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
          <Harness context={context} overlay={overlay} resultRef={resultRef} />
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
  it('offsets the overlay composer by the measured iOS keyboard inset', () => {
    const tree = render(baseContext({ composerOverlayInset: 291 }), true);
    const overlay = root(tree).findAll((node) => {
      const style = StyleSheet.flatten(node.props['style'] as never) as {
        bottom?: number;
        position?: string;
      };
      return style?.position === 'absolute' && style?.bottom === 291;
    })[0];

    expect(requireTestValue(overlay, 'composer overlay')).toBeTruthy();
    act(() => tree.unmount());
  });

  it('keeps floating activity status non-interactive above the composer', () => {
    const tree = render(
      baseContext({
        activityDetail: 'Installing dependencies',
        displayedActivity: { tone: 'running', title: 'Working' },
        showFloatingActivity: true,
      }),
      true,
    );
    const dock = root(tree).findAll((node) => node.props['testID'] === 'floating-activity-dock')[0];

    expect(requireTestValue(dock, 'floating activity dock').props['pointerEvents']).toBe('none');
    expect(
      root(tree).findAll((node) => node.children.includes('Installing dependencies')).length,
    ).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('renders composer errors on an opaque elevated surface', () => {
    const tree = render(baseContext({ visibleError: 'Connection failed' }), true);
    const alert = root(tree).findAll((node) => node.props['accessibilityRole'] === 'alert')[0];
    const style = StyleSheet.flatten(
      requireTestValue(alert, 'composer error alert').props['style'] as never,
    ) as { backgroundColor?: string };

    expect(style.backgroundColor).toBe(theme.colors.bgElevated);
    expect(style.backgroundColor).not.toContain('rgba');
    act(() => tree.unmount());
  });

  it('keeps the disabled Send control in the empty idle chat composer', () => {
    const tree = render(
      baseContext({
        draft: '',
        selectedChat: {
          id: 'chat-1',
          title: 'Chat',
          status: 'idle',
          createdAt: '2026-08-03T00:00:00.000Z',
          updatedAt: '2026-08-03T00:00:00.000Z',
          statusUpdatedAt: '2026-08-03T00:00:00.000Z',
          lastMessagePreview: '',
          messages: [],
        },
      }),
    );
    const send = root(tree).findAll(
      (node) =>
        node.props['accessibilityLabel'] === 'Send message' &&
        (node.props['accessibilityState'] as { disabled?: boolean } | undefined)?.disabled === true,
    );

    expect(send).not.toHaveLength(0);
    expect(
      root(tree).findAll((node) => node.props['testID'] === 'composer-submit-slot'),
    ).not.toHaveLength(0);
    act(() => tree.unmount());
  });

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

  it('disables attachments and labels submit as save while editing a queued message', () => {
    const context = baseContext({
      draft: 'Updated queued message',
      editingQueuedMessage: true,
    });
    const tree = render(context);

    expect(
      root(tree).findAll(
        (node) =>
          node.props['accessibilityLabel'] === 'Save queued message' &&
          typeof node.props['onPress'] === 'function',
      ),
    ).toHaveLength(1);
    expect(
      root(tree).findAll(
        (node) =>
          node.props['accessibilityLabel'] === 'Add attachment' &&
          typeof node.props['onPress'] === 'function' &&
          (node.props['disabled'] === true ||
            (node.props['accessibilityState'] as { disabled?: boolean } | undefined)?.disabled ===
              true),
      ),
    ).toHaveLength(1);
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
