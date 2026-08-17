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
import { setMockReducedMotionEnabled } from '@shared/testing/reanimatedMock';
import { responseUsageOverlayAtom } from '../state/modals';
import { MessageActions } from './MessageActions';
import { ResponseUsageOverlay } from './ResponseUsageOverlay';
import {
  POUR_CONTENT_OFFSET,
  POUR_EXIT_MS,
  POUR_MIN_SHELL_OPACITY,
  POUR_START_SCALE,
} from './responseUsagePour';

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

function flattenStyle(node: QueryableInstance | undefined): Record<string, unknown> {
  return StyleSheet.flatten(node?.props['style'] as never) ?? {};
}

/**
 * Reanimated's Jest double settles animations into its shared values, and the rendered style only
 * picks them up on the next render, so sampling one means re-rendering first.
 */
function sampleStyle(
  tree: ReactTestRenderer,
  element: React.ReactNode,
  testID: string,
): Record<string, unknown> {
  act(() => {
    tree.update(wrap(element));
  });
  return flattenStyle(findHostByTestId(queryRoot(tree), testID));
}

/** Runs the retracting panel's exit out, which is what finally unmounts it. */
function settleExit(): void {
  act(() => {
    jest.advanceTimersByTime(POUR_EXIT_MS);
  });
}

describe('MessageActions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMeasureAnchor.mockReset();
  });

  afterEach(() => {
    // The overlay atom outlives a render, so a leftover panel would leak into the next test. It is
    // cleared before the timers run out so the panel's retraction lands inside act().
    act(() => {
      getDefaultStore().set(responseUsageOverlayAtom, null);
    });
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
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
    settleExit();
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

    // The retracting panel must stop swallowing taps the instant it is dismissed, or it would eat
    // whatever the reader reached for next.
    const overlayRoot = findHostByTestId(queryRoot(tree), 'response-usage-overlay');
    expect(overlayRoot?.props['pointerEvents']).toBe('none');
    expect(overlayRoot?.props['accessibilityViewIsModal']).toBe(false);

    settleExit();
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
    settleExit();
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

    settleExit();
    expect(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')).toBeUndefined();
    expect(
      findPressable(queryRoot(tree), 'Response details').props['accessibilityState'],
    ).toMatchObject({ expanded: false });
  });

  describe('the pour', () => {
    const anchor = { x: 24, y: 500, width: 30, height: 30 };
    const panelLayout = { x: 0, y: 0, width: 180, height: 96 };

    function openPlacedPanel(): { tree: ReactTestRenderer; element: React.ReactElement } {
      mockMeasureAnchor.mockImplementation((_node, onMeasured) => {
        onMeasured(anchor);
      });
      const element = <MessageActions text="hello" testID="usage" usage={sampleUsage} />;
      const tree = render(element);
      act(() => {
        invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
      });
      return { tree, element };
    }

    function measurePanel(tree: ReactTestRenderer): void {
      act(() => {
        invokeProp(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')!, 'onLayout', {
          nativeEvent: { layout: panelLayout },
        });
      });
    }

    it('waits off screen as an unpoured bead until it knows where it belongs', () => {
      const element = <MessageActions text="hello" testID="usage" usage={sampleUsage} />;
      const tree = render(element);
      act(() => {
        invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
      });

      // Pouring before the anchor lands would spend the whole animation at left: -9999 and land
      // the panel on screen already formed, which is the pop the pour exists to replace.
      const style = sampleStyle(tree, element, 'response-usage-overlay-panel');
      expect(style['left']).toBe(-9999);
      expect(style['opacity']).toBe(POUR_MIN_SHELL_OPACITY);
      expect(style['transform']).toEqual([
        { scaleX: POUR_START_SCALE },
        { scaleY: POUR_START_SCALE },
      ]);
      expect(sampleStyle(tree, element, 'response-usage-overlay-content')['opacity']).toBe(0);
    });

    it('pours out of the button it is anchored to and settles into its full shape', () => {
      const { tree, element } = openPlacedPanel();
      measurePanel(tree);

      const style = sampleStyle(tree, element, 'response-usage-overlay-panel');
      // Growing about the centre would swell the glass beside the button rather than out of it,
      // so it scales about the edge facing the anchor, under the anchor's centre.
      expect(style['transformOrigin']).toEqual([
        anchor.x + anchor.width / 2 - Number(style['left']),
        panelLayout.height,
        0,
      ]);
      expect(style['opacity']).toBe(1);
      expect(style['transform']).toEqual([{ scaleX: 1 }, { scaleY: 1 }]);

      // The readings settle into the shape after it forms rather than arriving stretched with it.
      const content = sampleStyle(tree, element, 'response-usage-overlay-content');
      expect(content['opacity']).toBe(1);
      expect(content['transform']).toEqual([{ translateY: 0 }]);
    });

    it('travels the readings away from the button, whichever side the panel landed on', () => {
      mockMeasureAnchor.mockImplementation((_node, onMeasured) => {
        // A response at the very top of the transcript leaves no room above its action row.
        onMeasured({ x: 24, y: 80, width: 30, height: 30 });
      });
      const element = <MessageActions text="hello" testID="usage" usage={sampleUsage} />;
      const tree = render(element);
      act(() => {
        invokeProp(findPressable(queryRoot(tree), 'Response details'), 'onPress');
      });
      measurePanel(tree);

      // Flipped below its button, so it grows out of its top edge.
      const style = sampleStyle(tree, element, 'response-usage-overlay-panel');
      expect(style['transformOrigin']).toEqual([15, 0, 0]);
      expect(sampleStyle(tree, element, 'response-usage-overlay-content')['transform']).toEqual([
        { translateY: 0 },
      ]);

      act(() => {
        invokeProp(findByTestId(queryRoot(tree), 'response-usage-overlay-backdrop')!, 'onPress');
      });

      // Retracting, the readings leave the way they arrived: upward, back into the button below.
      expect(sampleStyle(tree, element, 'response-usage-overlay-content')['transform']).toEqual([
        { translateY: -POUR_CONTENT_OFFSET },
      ]);
    });

    it('retracts into its button before it leaves, instead of vanishing between frames', () => {
      const { tree, element } = openPlacedPanel();
      measurePanel(tree);
      act(() => {
        tree.update(wrap(element));
      });

      act(() => {
        invokeProp(findByTestId(queryRoot(tree), 'response-usage-overlay-backdrop')!, 'onPress');
      });

      // The panel is still on screen, drawing itself back down into the button that opened it.
      expect(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')).toBeDefined();
      const style = sampleStyle(tree, element, 'response-usage-overlay-panel');
      expect(style['opacity']).toBe(POUR_MIN_SHELL_OPACITY);
      expect(style['transform']).toEqual([
        { scaleX: POUR_START_SCALE },
        { scaleY: POUR_START_SCALE },
      ]);
      expect(sampleStyle(tree, element, 'response-usage-overlay-content')['opacity']).toBe(0);
      expect(sampleStyle(tree, element, 'response-usage-overlay-content')['transform']).toEqual([
        { translateY: POUR_CONTENT_OFFSET },
      ]);

      settleExit();
      expect(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')).toBeUndefined();
    });

    it('never fades the glass to zero, which would stop UIKit rendering the material', () => {
      const { tree, element } = openPlacedPanel();
      measurePanel(tree);
      act(() => {
        invokeProp(findByTestId(queryRoot(tree), 'response-usage-overlay-backdrop')!, 'onPress');
      });

      expect(
        Number(sampleStyle(tree, element, 'response-usage-overlay-panel')['opacity']),
      ).toBeGreaterThan(0);
    });

    it('drops the panel immediately when the reader asked for reduced motion', () => {
      setMockReducedMotionEnabled(true);
      try {
        const { tree } = openPlacedPanel();
        measurePanel(tree);

        act(() => {
          invokeProp(findByTestId(queryRoot(tree), 'response-usage-overlay-backdrop')!, 'onPress');
        });

        // There is no exit to cover, so holding the panel back would just leave it sitting there.
        expect(findByTestId(queryRoot(tree), 'response-usage-overlay-panel')).toBeUndefined();
      } finally {
        setMockReducedMotionEnabled(false);
      }
    });

    it('pours a second row\u2019s panel from its own button rather than reusing the first', () => {
      let tree: ReactTestRenderer | undefined;
      const element = (
        <>
          <MessageActions text="first" testID="first" usage={sampleUsage} />
          <MessageActions text="second" testID="second" usage={sampleUsage} />
        </>
      );
      mockMeasureAnchor.mockImplementationOnce((_node, onMeasured) => {
        onMeasured(anchor);
      });
      act(() => {
        tree = renderer.create(wrap(element));
      });
      const infoButton = (testID: string) =>
        queryRoot(tree!)
          .findAll(
            (node) =>
              node.props['testID'] === `${testID}-info` &&
              typeof node.props['onPress'] === 'function',
          )
          .at(-1)!;

      act(() => {
        invokeProp(infoButton('first'), 'onPress');
      });
      measurePanel(tree!);
      act(() => {
        tree!.update(wrap(element));
      });
      expect(sampleStyle(tree!, element, 'response-usage-overlay-panel')['transform']).toEqual([
        { scaleX: 1 },
        { scaleY: 1 },
      ]);

      mockMeasureAnchor.mockImplementation((_node, onMeasured) => {
        onMeasured({ x: 200, y: 300, width: 30, height: 30 });
      });
      act(() => {
        invokeProp(infoButton('second'), 'onPress');
      });

      // Carrying the first panel's measurement over would leave the replacement already formed,
      // parked over the row that no longer owns it.
      const style = sampleStyle(tree!, element, 'response-usage-overlay-panel');
      expect(style['left']).toBe(-9999);
      expect(style['transform']).toEqual([
        { scaleX: POUR_START_SCALE },
        { scaleY: POUR_START_SCALE },
      ]);
    });
  });
});
