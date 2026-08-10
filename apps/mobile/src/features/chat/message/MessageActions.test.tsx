import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  getRenderedGlassViewProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { MessageActions } from './MessageActions';

jest.mock('expo-clipboard', () => ({
  __esModule: true,
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

const mockClipboard = Clipboard as unknown as { setStringAsync: jest.Mock };
const mockHaptics = Haptics as unknown as { notificationAsync: jest.Mock };

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

const theme = createAppTheme('dark');

const sampleUsage = {
  inputTokens: 12_400,
  outputTokens: 1_280,
  reasoningTokens: 300,
  cachedReadTokens: 111_600,
  cachedWriteTokens: 900,
  totalTokens: 126_180,
  model: 'GPT-5.6 Sol',
};

function wrap(node: React.ReactNode) {
  return <AppThemeProvider theme={theme}>{node}</AppThemeProvider>;
}

function render(node: React.ReactNode): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(wrap(node));
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function findPressable(root: QueryableInstance, label: string): QueryableInstance {
  const matches = root.findAll(
    (node) =>
      typeof node.props['onPress'] === 'function' && node.props['accessibilityLabel'] === label,
  );
  // Wrappers forward both props, so the deepest match is the host pressable that owns the state.
  const match = matches[matches.length - 1];
  if (!match) {
    throw new Error(`Missing pressable: ${label}`);
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

function findByTestId(root: QueryableInstance, testID: string): QueryableInstance | undefined {
  return root.findAll((node) => node.props['testID'] === testID)[0];
}

/** Wrappers forward `testID`, so the deepest match is the host view that owns the resolved style. */
function findHostByTestId(root: QueryableInstance, testID: string): QueryableInstance | undefined {
  return root.findAll((node) => node.props['testID'] === testID).at(-1);
}

function collectText(node: QueryableInstance): string[] {
  return node.children.flatMap((child) =>
    typeof child === 'string' ? [child] : collectText(child),
  );
}

describe('MessageActions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders nothing for blank text', () => {
    const tree = render(<MessageActions text="   " />);
    expect((tree as unknown as { toJSON(): unknown }).toJSON()).toBeNull();
  });

  it('still offers the fork action for a response that has no copyable text', () => {
    const tree = render(
      <MessageActions text="   " onSelectText={() => {}} onForkConversation={() => {}} />,
    );
    const root = queryRoot(tree);
    expect(findPressable(root, 'Fork conversation from here')).toBeDefined();
    expect(() => findPressable(root, 'Copy message')).toThrow();
    expect(() => findPressable(root, 'Select message text')).toThrow();
  });

  it('copies the message, fires a success haptic, and shows a copied state', async () => {
    const tree = render(<MessageActions text="hello world" />);
    const root = queryRoot(tree);
    const copyButton = findPressable(root, 'Copy message');

    await act(async () => {
      invokeProp(copyButton, 'onPress');
      await Promise.resolve();
    });

    expect(mockClipboard.setStringAsync).toHaveBeenCalledWith('hello world');
    expect(mockHaptics.notificationAsync).toHaveBeenCalledWith('success');
    expect(findPressable(root, 'Copied message')).toBeDefined();
  });

  it('keeps copy, select, and fork together with effective touch targets', () => {
    const tree = render(
      <MessageActions text="hello" onSelectText={() => {}} onForkConversation={() => {}} />,
    );
    const root = queryRoot(tree);
    const copyButton = findPressable(root, 'Copy message');
    const selectButton = findPressable(root, 'Select message text');
    const forkButton = findPressable(root, 'Fork conversation from here');

    for (const button of [copyButton, selectButton, forkButton]) {
      const hitSlop = button.props['hitSlop'] as
        { top: number; bottom: number; left: number; right: number } | undefined;
      expect(hitSlop).toBeDefined();
      expect(hitSlop!.top).toBeGreaterThan(0);
      expect(hitSlop!.bottom).toBeGreaterThan(0);
    }
  });

  it('omits the select-text action when no handler is provided', () => {
    const tree = render(<MessageActions text="hello" />);
    const root = queryRoot(tree);
    expect(
      root.findAll((node) => node.props['accessibilityLabel'] === 'Select message text'),
    ).toHaveLength(0);
  });

  it('invokes onSelectText when the select action is pressed', () => {
    const onSelectText = jest.fn();
    const tree = render(<MessageActions text="hello" onSelectText={onSelectText} />);
    const root = queryRoot(tree);
    invokeProp(findPressable(root, 'Select message text'), 'onPress');
    expect(onSelectText).toHaveBeenCalledTimes(1);
  });

  it('invokes the fork action and exposes its busy state', () => {
    const onForkConversation = jest.fn();
    const tree = render(
      <MessageActions text="hello" onForkConversation={onForkConversation} forkBusy />,
    );
    const forkButton = findPressable(queryRoot(tree), 'Fork conversation from here');

    expect(forkButton.props['disabled']).toBe(true);
    expect(forkButton.props['accessibilityState']).toEqual({ busy: true, disabled: true });

    act(() => {
      tree.update(wrap(<MessageActions text="hello" onForkConversation={onForkConversation} />));
    });
    invokeProp(findPressable(queryRoot(tree), 'Fork conversation from here'), 'onPress');
    expect(onForkConversation).toHaveBeenCalledTimes(1);
  });

  it('omits the response details action when the turn reported no usage', () => {
    const tree = render(<MessageActions text="hello" />);
    expect(
      queryRoot(tree).findAll((node) => node.props['accessibilityLabel'] === 'Response details'),
    ).toHaveLength(0);
  });

  it('toggles the response details panel and reports model, tokens, and cache share', () => {
    const tree = render(
      <MessageActions
        text="hello"
        testID="chat-message-copy-m1"
        usage={{
          inputTokens: 12_400,
          outputTokens: 1_280,
          reasoningTokens: 300,
          cachedReadTokens: 111_600,
          cachedWriteTokens: 900,
          totalTokens: 126_180,
          model: 'GPT-5.6 Sol',
        }}
      />,
    );
    const infoButton = findPressable(queryRoot(tree), 'Response details');
    expect(infoButton.props['accessibilityState']).toMatchObject({ expanded: false });
    expect(findByTestId(queryRoot(tree), 'chat-message-copy-m1-info-card')).toBeUndefined();

    act(() => {
      invokeProp(infoButton, 'onPress');
    });

    const card = findByTestId(queryRoot(tree), 'chat-message-copy-m1-info-card');
    expect(card).toBeDefined();
    expect(collectText(card!)).toEqual([
      'Model',
      'GPT-5.6 Sol',
      'Input',
      '12,400',
      'Output',
      '1,280',
      'Cached',
      '90%',
    ]);
    expect(
      findPressable(queryRoot(tree), 'Response details').props['accessibilityState'],
    ).toMatchObject({ expanded: true });

    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });
    expect(findByTestId(queryRoot(tree), 'chat-message-copy-m1-info-card')).toBeUndefined();
  });

  it('offers response details for a turn that produced no copyable text', () => {
    const tree = render(
      <MessageActions
        text="   "
        usage={{
          inputTokens: 10,
          outputTokens: 2,
          reasoningTokens: null,
          cachedReadTokens: null,
          cachedWriteTokens: null,
          totalTokens: 12,
          model: null,
        }}
      />,
    );
    const root = queryRoot(tree);
    expect(findPressable(root, 'Response details')).toBeDefined();
    expect(() => findPressable(root, 'Copy message')).toThrow();
  });

  it('paints the response details panel with the native capsule glass material', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);

    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });

    const glassProps = getRenderedGlassViewProps().find(
      (props) => props.testID === 'usage-info-card',
    );
    expect(glassProps?.glassEffectStyle).toBe(theme.glass.capsule.glassEffectStyle);
    expect(glassProps?.tintColor).toBe(theme.glass.capsule.tintColor);

    // An opaque fill would sit in front of the material and defeat the glass.
    const cardStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'usage-info-card')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(cardStyle['backgroundColor']).toBeUndefined();
  });

  it('falls back to a solid bordered panel where liquid glass is unavailable', () => {
    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });

    const glassProps = getRenderedGlassViewProps().find(
      (props) => props.testID === 'usage-info-card',
    );
    expect(glassProps?.glassEffectStyle).toBe('none');
    const cardStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'usage-info-card')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(cardStyle['backgroundColor']).toBe(theme.glass.capsule.fallbackBackgroundColor);
    expect(cardStyle['borderColor']).toBe(theme.glass.capsule.fallbackBorderColor);
    expect(cardStyle['borderWidth']).toBe(StyleSheet.hairlineWidth);
  });
});
