import React from 'react';
import { getDefaultStore } from 'jotai';
import { BackHandler, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  getRenderedGlassViewProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { responseUsageOverlayAtom } from '../state/modals';
import { MessageActions } from './MessageActions';
import { ResponseUsageOverlay } from './ResponseUsageOverlay';

jest.mock('./measureAnchor', () => ({
  __esModule: true,
  measureAnchor: jest.fn(),
}));

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

const mockMeasureAnchor = jest.requireMock('./measureAnchor').measureAnchor as jest.Mock;
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
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 59, right: 0, bottom: 34, left: 0 },
      }}
    >
      <AppThemeProvider theme={theme}>
        {node}
        {/* The panel is hosted at screen level, so a row on its own can never show one. */}
        <ResponseUsageOverlay />
      </AppThemeProvider>
    </SafeAreaProvider>
  );
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
    mockMeasureAnchor.mockReset();
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
    // The overlay atom outlives a render, so a leftover panel would leak into the next test.
    getDefaultStore().set(responseUsageOverlayAtom, null);
  });

  it('renders nothing for blank text', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={theme}>
          <MessageActions text="   " />
        </AppThemeProvider>,
      );
    });
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
    expect(findByTestId(queryRoot(tree), 'response-usage-overlay-card')).toBeUndefined();

    act(() => {
      invokeProp(infoButton, 'onPress');
    });

    const card = findByTestId(queryRoot(tree), 'response-usage-overlay-card');
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
    expect(findByTestId(queryRoot(tree), 'response-usage-overlay-card')).toBeUndefined();
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
      (props) => props.testID === 'response-usage-overlay-card',
    );
    expect(glassProps?.glassEffectStyle).toBe(theme.glass.capsule.glassEffectStyle);
    expect(glassProps?.tintColor).toBe(theme.glass.capsule.tintColor);

    // An opaque fill would sit in front of the material and defeat the glass.
    const cardStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay-card')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(cardStyle['backgroundColor']).toBeUndefined();
  });

  it('falls back to a solid bordered panel where liquid glass is unavailable', () => {
    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });

    const glassProps = getRenderedGlassViewProps().find(
      (props) => props.testID === 'response-usage-overlay-card',
    );
    expect(glassProps?.glassEffectStyle).toBe('none');
    const cardStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay-card')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(cardStyle['backgroundColor']).toBe(theme.glass.capsule.fallbackBackgroundColor);
    expect(cardStyle['borderColor']).toBe(theme.glass.capsule.fallbackBorderColor);
    expect(cardStyle['borderWidth']).toBe(StyleSheet.hairlineWidth);
  });

  it('floats the response details panel over the screen instead of displacing the transcript', () => {
    const tree = render(
      <View testID="row-scope">
        <MessageActions text="hello" testID="usage" usage={sampleUsage} />
      </View>,
    );
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });

    // Laying the panel out in flow pushed every later message down, moving the response the
    // reader was looking at off screen, so it has to overlay the screen instead.
    const panelStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay-panel')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(panelStyle['position']).toBe('absolute');
    expect(panelStyle['marginTop']).toBeUndefined();

    // The panel must not live inside the transcript row, or opening it would grow that row and
    // push every later message down.
    const row = findByTestId(queryRoot(tree), 'row-scope');
    expect(
      row!.findAll((node) => node.props['testID'] === 'response-usage-overlay-panel'),
    ).toHaveLength(0);

    const cardStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay-card')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(cardStyle['position']).toBeUndefined();
    expect(cardStyle['marginTop']).toBeUndefined();
  });

  it('dismisses the panel when anything outside it is tapped', () => {
    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });
    const backdrop = findByTestId(queryRoot(tree), 'response-usage-overlay-backdrop');
    expect(backdrop).toBeDefined();

    act(() => {
      invokeProp(backdrop!, 'onPress');
    });

    expect(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')).toBeUndefined();
    expect(
      findPressable(queryRoot(tree), 'Response details').props['accessibilityState'],
    ).toMatchObject({ expanded: false });
  });

  it('covers the whole screen with the dismissal backdrop', () => {
    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });

    // A backdrop confined to the transcript would leave taps on the header and composer landing
    // on those controls with a stale panel still floating over them.
    const backdropStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay-backdrop')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(backdropStyle).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });

    const rootStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(rootStyle).toMatchObject({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('keeps only one panel open across rows', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <>
            <MessageActions text="first" testID="first" usage={sampleUsage} />
            <MessageActions text="second" testID="second" usage={sampleUsage} />
          </>,
        ),
      );
    });
    const root = queryRoot(tree!);
    // Pressable forwards `testID` to its host view, so the composite owns `onPress`.
    const infoButton = (testID: string) =>
      root
        .findAll(
          (node) =>
            node.props['testID'] === `${testID}-info` &&
            typeof node.props['onPress'] === 'function',
        )
        .at(-1)!;

    act(() => {
      invokeProp(infoButton('first'), 'onPress');
    });
    expect(infoButton('first').props['accessibilityState']).toMatchObject({ expanded: true });

    act(() => {
      invokeProp(infoButton('second'), 'onPress');
    });

    // One host means a second tap replaces the panel instead of stacking another one over it.
    expect(
      root.findAll(
        (node) =>
          typeof node.type === 'string' && node.props['testID'] === 'response-usage-overlay-panel',
      ),
    ).toHaveLength(1);
    expect(infoButton('first').props['accessibilityState']).toMatchObject({ expanded: false });
    expect(infoButton('second').props['accessibilityState']).toMatchObject({ expanded: true });
  });

  it('dismisses the panel on the Android back button', () => {
    const handlers: Array<() => boolean> = [];
    const addEventListener = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, handler) => {
        handlers.push(handler as () => boolean);
        return { remove: jest.fn() };
      });

    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });
    expect(addEventListener).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));

    let handled: boolean | undefined;
    act(() => {
      handled = handlers[handlers.length - 1]?.();
    });

    // Swallowing the event stops back from also popping the screen out from under the panel.
    expect(handled).toBe(true);
    expect(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')).toBeUndefined();
  });

  it('anchors the panel to the measured position of its info button', () => {
    mockMeasureAnchor.mockImplementation((_node, onMeasured) => {
      onMeasured({ x: 24, y: 500, width: 30, height: 30 });
    });

    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });
    act(() => {
      invokeProp(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')!, 'onLayout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 180, height: 96 } },
      });
    });

    const panelStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay-panel')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(panelStyle['left']).toBe(24);
    expect(panelStyle['top']).toBe(500 - 8 - 96);
  });

  it('opens the panel even when the anchor never reports a position', () => {
    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });

    // Waiting on measurement to open would silently swallow the tap wherever it never lands, so
    // the panel opens immediately and waits off screen for its anchor instead.
    const panelStyle = StyleSheet.flatten(
      findHostByTestId(queryRoot(tree), 'response-usage-overlay-panel')?.props['style'] as never,
    ) as Record<string, unknown>;
    expect(panelStyle['left']).toBe(-9999);
    expect(
      findPressable(queryRoot(tree), 'Response details').props['accessibilityState'],
    ).toMatchObject({ expanded: true });
  });

  it('dismisses the floating panel when the panel itself is tapped', () => {
    const tree = render(<MessageActions text="hello" testID="usage" usage={sampleUsage} />);
    act(() => {
      invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
    });
    // Pressable forwards `testID` to its host view, so the composite owns `onPress`.
    const panel = findByTestId(queryRoot(tree), 'response-usage-overlay-panel');
    expect(panel).toBeDefined();

    act(() => {
      invokeProp(panel!, 'onPress');
    });

    expect(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')).toBeUndefined();
    expect(
      findPressable(queryRoot(tree), 'Response details').props['accessibilityState'],
    ).toMatchObject({ expanded: false });
  });
});
