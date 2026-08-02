import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { Chat } from '../../api/types';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { MainScreenHeaderAndWorkflow } from './MainScreenHeaderAndWorkflow';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './mainScreenPanelCollapseCoordinator';

jest.mock('react-native-reanimated', () => jest.requireActual('../../testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

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
  if (!tree) throw new Error('Component did not render');
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function findPressableByLabelPrefix(root: QueryableInstance, prefix: string): QueryableInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string' &&
      (node.props.accessibilityLabel as string).startsWith(prefix),
  )[0];
  if (!match) throw new Error(`Missing pressable starting with: ${prefix}`);
  return match;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') throw new Error(`Missing callback: ${name}`);
  return callback(...args);
}

describe('MainScreenHeaderAndWorkflow session meta chips', () => {
  beforeEach(() => {
    mockHaptics.selectionAsync.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gives the model, thinking, agent mode, agent thread, and fast chips an effective touch target', () => {
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
      const hitSlop = chip.props.hitSlop as
        { top: number; bottom: number; left: number; right: number } | undefined;
      expect(hitSlop).toBeDefined();
      expect(hitSlop!.top).toBeGreaterThan(0);
      expect(hitSlop!.bottom).toBeGreaterThan(0);
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

  it('does not render session meta chips while a chat is opening', () => {
    const context = baseContext({ isOpeningChat: true });
    const tree = render(context);
    const root = queryRoot(tree);

    expect(
      root.findAll(
        (node) =>
          typeof node.props.accessibilityLabel === 'string' &&
          (node.props.accessibilityLabel as string).startsWith('Model,'),
      ),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });
});
