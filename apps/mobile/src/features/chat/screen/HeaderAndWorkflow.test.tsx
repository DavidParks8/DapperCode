import React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { Chat } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { requireTestValue } from '@shared/testing/requireTestValue';
import {
  getRenderedGlassViewProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { formatCompactTokenCount, MainScreenHeaderAndWorkflow } from './HeaderAndWorkflow';
import { SESSION_META_CHIP_HEIGHT } from '../styles/sessionMetaChip';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  return {
    Ionicons: ({ name, color }: { name: string; color: string }) =>
      mockReact.createElement('ionicon', { name, color }),
  };
});

jest.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

import * as Haptics from 'expo-haptics';

const mockHaptics = Haptics as unknown as { selectionAsync: jest.Mock };

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const chat: Chat = {
  id: 'thread',
  title: 'Session',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'latest',
  messages: [],
};

function baseContext(overrides: Partial<Context> = {}): Context {
  return {
    onOpenDrawer: jest.fn(),
    headerTitle: 'Session',
    activeAgent: null,
    selectedChat: chat,
    openTitleEditor: jest.fn(),
    handleOpenGit: jest.fn(),
    isOpeningChat: false,
    modelOptions: [{ id: 'model-a', label: 'Model A' }],
    openModelModal: jest.fn(),
    activeModelLabel: 'Model A',
    activeModelEffortOptions: [{ id: 'high', label: 'High' }],
    openEffortModal: jest.fn(),
    activeEffortLabel: 'High',
    openCollaborationModeMenu: jest.fn(),
    collaborationModeLabel: 'Default mode',
    showAgentThreadChip: true,
    openAgentThreadSelector: jest.fn().mockResolvedValue(undefined),
    agentThreadChipLabel: 'Agent threads, 2',
    supportsFastMode: true,
    fastModeEnabled: false,
    fastModeControlDisabled: false,
    toggleFastMode: jest.fn().mockResolvedValue(undefined),
    showTopCardsRow: false,
    workflowBridgeUiSurfaces: [],
    windowHeight: 800,
    handleBridgeUiAction: jest.fn(),
    dismissBridgeUiSurface: jest.fn(),
    workflowCardMode: null,
    selectedThreadPlan: null,
    planPanelCollapsed: false,
    toggleSelectedPlanPanel: jest.fn(),
    implementPlan: jest.fn().mockResolvedValue(undefined),
    stayInPlanMode: jest.fn(),
    ...overrides,
  } as unknown as Context;
}

function render(context: Context): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <AppThemeProvider theme={theme}>
          <MainScreenHeaderAndWorkflow context={context} />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function findPressableByLabelPrefix(root: QueryableInstance, prefix: string): QueryableInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props['onPress'] === 'function' &&
      typeof node.props['accessibilityLabel'] === 'string' &&
      node.props['accessibilityLabel'].startsWith(prefix),
  )[0];
  if (!match) {
    throw new Error(`Missing pressable starting with: ${prefix}`);
  }
  return match;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') {
    throw new Error(`Missing callback: ${name}`);
  }
  return callback(...args);
}

describe('MainScreenHeaderAndWorkflow session meta chips', () => {
  beforeEach(() => {
    mockHaptics.selectionAsync.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders model, thinking, agent mode, agent thread, and fast controls at composer height', () => {
    const context = baseContext();
    const tree = render(context);
    const root = queryRoot(tree);

    for (const prefix of [
      'Model,',
      'Thinking level,',
      'Agent mode,',
      'Agent threads,',
      'Fast mode',
    ]) {
      const chip = findPressableByLabelPrefix(root, prefix);
      const hitSlop = chip.props['hitSlop'] as
        { top: number; bottom: number; left: number; right: number } | undefined;
      expect(hitSlop).toBeDefined();
      const chipStyle = chip.props['style'] as (state: { pressed: boolean }) => unknown;
      expect(StyleSheet.flatten(chipStyle({ pressed: false }) as never)).toMatchObject({
        minHeight: SESSION_META_CHIP_HEIGHT,
      });
      // The chip box is shorter than a touch target, so the vertical slop makes up the difference
      // while staying capped so it cannot swallow the header buttons above.
      const expectedVerticalSlop = Math.min(8, (44 - SESSION_META_CHIP_HEIGHT) / 2);
      expect(hitSlop!.top).toBe(expectedVerticalSlop);
      expect(hitSlop!.bottom).toBe(expectedVerticalSlop);
      expect(SESSION_META_CHIP_HEIGHT + hitSlop!.top + hitSlop!.bottom).toBeGreaterThanOrEqual(44);
    }
    act(() => tree.unmount());
  });

  it('fires a selection haptic and opens the model modal when the model chip is pressed', () => {
    const context = baseContext();
    const tree = render(context);
    const root = queryRoot(tree);

    invokeProp(findPressableByLabelPrefix(root, 'Model,'), 'onPress');

    expect(mockHaptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(context.openModelModal).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('keeps every session control on the chip row before a chat exists', () => {
    // The compose screen used to stack these as full-width rows in its own body. They now live on
    // the one chip row, so the row has to render without a selected chat.
    const context = baseContext({
      selectedChat: null,
      headerTitle: 'New chat',
      readyAgents: [
        { id: 'codex', label: 'Codex' },
        { id: 'claude', label: 'Claude' },
      ],
      activeAgentLabel: 'Codex',
      openAgentModal: jest.fn(),
    } as unknown as Partial<Context>);
    const tree = render(context);
    const root = queryRoot(tree);

    expect(
      root.findAll((node) => node.props['testID'] === 'session-meta-row').length,
    ).toBeGreaterThan(0);
    for (const prefix of ['Agent,', 'Model,', 'Thinking level,', 'Agent mode,', 'Fast mode']) {
      expect(() => findPressableByLabelPrefix(root, prefix)).not.toThrow();
    }

    invokeProp(findPressableByLabelPrefix(root, 'Agent,'), 'onPress');
    expect(context.openAgentModal).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('drops the agent chip once a chat is bound to the agent that created it', () => {
    const context = baseContext({
      readyAgents: [
        { id: 'codex', label: 'Codex' },
        { id: 'claude', label: 'Claude' },
      ],
      activeAgentLabel: 'Codex',
      openAgentModal: jest.fn(),
    } as unknown as Partial<Context>);
    const tree = render(context);
    const root = queryRoot(tree);

    expect(() => findPressableByLabelPrefix(root, 'Agent,')).toThrow();
    // The agent-thread chip also starts with "Agent", so the row itself must still be there.
    expect(
      root.findAll((node) => node.props['testID'] === 'session-meta-row').length,
    ).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('offers no agent chip when only one agent is ready to run', () => {
    const context = baseContext({
      selectedChat: null,
      readyAgents: [{ id: 'codex', label: 'Codex' }],
      activeAgentLabel: 'Codex',
      openAgentModal: jest.fn(),
    } as unknown as Partial<Context>);
    const tree = render(context);
    const root = queryRoot(tree);

    expect(() => findPressableByLabelPrefix(root, 'Agent,')).toThrow();
    act(() => tree.unmount());
  });

  it('leaves the opening placeholder without a chip row to configure', () => {
    const context = baseContext({ selectedChat: null, isOpeningChat: true });
    const tree = render(context);
    const root = queryRoot(tree);

    expect(root.findAll((node) => node.props['testID'] === 'session-meta-row')).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('fires a selection haptic and opens the agent mode menu when the mode chip is pressed', () => {
    const context = baseContext();
    const tree = render(context);
    const root = queryRoot(tree);

    invokeProp(findPressableByLabelPrefix(root, 'Agent mode,'), 'onPress');

    expect(mockHaptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(context.openCollaborationModeMenu).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('fires a selection haptic and toggles fast mode when the fast chip is pressed', () => {
    const context = baseContext();
    const tree = render(context);
    const root = queryRoot(tree);

    invokeProp(findPressableByLabelPrefix(root, 'Fast mode'), 'onPress');

    expect(mockHaptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(context.toggleFastMode).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('uses primary text color for the top session selector controls', () => {
    const context = baseContext({ fastModeEnabled: true });
    const tree = render(context);
    const root = queryRoot(tree);
    const fastChip = findPressableByLabelPrefix(root, 'Fast mode');
    const fastText = fastChip.findAll((node) => node.children.includes('Fast'))[0];
    const fastIcon = fastChip.findAll((node) => node.type === 'ionicon')[0];

    expect(StyleSheet.flatten(fastText?.props['style'] as never)).toMatchObject({
      color: theme.colors.textPrimary,
    });
    expect(fastIcon?.props['color']).toBe(theme.colors.textPrimary);
    act(() => tree.unmount());
  });

  it('renders the header and flat selectors on one full-width glass plane', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);

    const tree = render(baseContext());
    const glassProps = getRenderedGlassViewProps().find(
      (props) => props.testID === 'chat-top-chrome-glass-surface',
    );

    expect(glassProps?.glassEffectStyle).toBe(theme.glass.chrome.glassEffectStyle);
    expect(glassProps?.tintColor).toBe(theme.glass.chrome.tintColor);
    expect(StyleSheet.flatten(glassProps?.style)).not.toHaveProperty('borderRadius');

    const root = queryRoot(tree);
    expect(
      root.findAll((node) => node.props['testID'] === 'session-meta-glass-surface'),
    ).toHaveLength(0);
    const selectorScrollView = root.findAll(
      (node) => node.props['testID'] === 'session-meta-selectors',
    )[0];
    expect(
      StyleSheet.flatten(
        requireTestValue(selectorScrollView, 'selector scroll view').props[
          'contentContainerStyle'
        ] as never,
      ),
    ).toMatchObject({ minHeight: SESSION_META_CHIP_HEIGHT });

    const modelChip = findPressableByLabelPrefix(root, 'Model,');
    const modelChipStyle = modelChip.props['style'] as (state: { pressed: boolean }) => unknown;
    const flatModelChipStyle = StyleSheet.flatten(modelChipStyle({ pressed: false }) as never);
    expect(flatModelChipStyle).toMatchObject({ minHeight: SESSION_META_CHIP_HEIGHT });
    expect(flatModelChipStyle).not.toHaveProperty('backgroundColor');
    expect(flatModelChipStyle).not.toHaveProperty('borderRadius');
    expect(flatModelChipStyle).not.toHaveProperty('borderWidth');
    expect(root.findAll((node) => node.props['testID'] === 'session-meta-divider')).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('tightens the gap above the selectors without cutting the space below them', () => {
    const tree = render(baseContext());
    const root = queryRoot(tree);

    const metaRow = root.findAll((node) => node.props['testID'] === 'session-meta-row')[0];
    const metaRowStyle = StyleSheet.flatten(
      requireTestValue(metaRow, 'session meta row').props['style'] as never,
    ) as { marginTop?: number; marginBottom?: number; paddingBottom?: number };

    // The 48pt circular buttons leave dead space under the title. The selector row reclaims it by
    // overlapping upward, which must not come out of its own bottom breathing room.
    expect(metaRowStyle.marginTop).toBeLessThan(0);
    expect(metaRowStyle.marginBottom ?? 0).toBeGreaterThan(0);

    const headerRow = root.findAll((node) => node.props['testID'] === 'chat-header-row')[0];

    // The header has to stay above the overlapping selector row so the leading button keeps its
    // full touch target.
    const headerStyle = StyleSheet.flatten(
      requireTestValue(headerRow, 'header row').props['style'] as never,
    ) as {
      zIndex?: number;
      minHeight?: number;
    };
    expect(headerStyle.minHeight).toBe(48);
    expect(headerStyle.zIndex).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('does not render session meta chips while a chat is opening', () => {
    const context = baseContext({ isOpeningChat: true });
    const tree = render(context);
    const root = queryRoot(tree);

    expect(
      root.findAll(
        (node) =>
          typeof node.props['accessibilityLabel'] === 'string' &&
          node.props['accessibilityLabel'].startsWith('Model,'),
      ),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('keeps token usage unavailable when the connected agent has not reported totals', () => {
    const tree = render(baseContext());
    const root = queryRoot(tree);

    expect(
      root.findAll(
        (node) => node.props['accessibilityLabel'] === 'Token usage, 507,800 tokens this session',
      ),
    ).toHaveLength(0);
    expect(
      root.findAll((node) => node.props['accessibilityLabel'] === 'Session tokens'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('renders the token chip and opens a ledger that omits unreported categories', () => {
    const tokenTotals = {
      turns: 14,
      inputTokens: 48200,
      outputTokens: 12400,
      reasoningTokens: null,
      cachedReadTokens: 386000,
      cachedWriteTokens: null,
      totalTokens: 507800,
    };
    const tree = render(
      baseContext({
        selectedChat: {
          ...chat,
          tokenTotals,
          acpUsage: { used: null, size: null, cost: '$4.20' },
        },
      }),
    );
    const root = queryRoot(tree);
    const chip = findPressableByLabelPrefix(root, 'Token usage,');

    expect(chip.props['accessibilityLabel']).toBe('Token usage, 507,800 tokens this session');
    expect(chip.findAll((node) => node.children.includes('508k tk'))).toHaveLength(1);
    act(() => {
      invokeProp(chip, 'onPress');
    });

    expect(root.findAll((node) => node.children.includes('Session tokens'))).toHaveLength(1);
    expect(
      root.findAll((node) => node.children.includes('Prompt, context and cache traffic')),
    ).toHaveLength(1);
    expect(
      root.findAll((node) => node.children.includes('Everything the model generated')),
    ).toHaveLength(1);
    expect(
      root
        .findAll((node) => node.props['testID'] === 'token-sent-subtotal')[0]
        ?.findAll((node) => node.children.includes('434,200')),
    ).toHaveLength(1);
    expect(
      root
        .findAll((node) => node.props['testID'] === 'token-received-subtotal')[0]
        ?.findAll((node) => node.children.includes('12,400')),
    ).toHaveLength(1);
    expect(root.findAll((node) => node.children.includes('Cache read'))).toHaveLength(1);
    expect(root.findAll((node) => node.children.includes('Cache write'))).toHaveLength(0);
    expect(root.findAll((node) => node.children.includes('Reasoning'))).toHaveLength(0);
    expect(root.findAll((node) => node.children.includes('Session cost '))).toHaveLength(1);
    act(() => tree.unmount());
  });
});

describe('formatCompactTokenCount', () => {
  it.each([
    [0, '0 tk'],
    [940, '940 tk'],
    [999, '999 tk'],
    [1_000, '1k tk'],
    [8_200, '8.2k tk'],
    [9_400, '9.4k tk'],
    [99_999, '100k tk'],
    [100_000, '100k tk'],
    [507_800, '508k tk'],
    [1_200_000, '1.2m tk'],
    [5_400_000, '5.4m tk'],
    [12_000_000, '12m tk'],
    [125_000_000, '125m tk'],
  ])('formats %i as %s', (value, expected) => {
    expect(formatCompactTokenCount(value)).toBe(expected);
  });
});
