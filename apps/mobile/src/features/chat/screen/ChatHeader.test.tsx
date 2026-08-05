import { requireTestValue } from '@shared/testing/requireTestValue';
import React from 'react';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  getRenderedGlassViewProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { CircularToolbarButton } from '@shared/ui/CircularToolbarButton';
import { ChatHeader } from './ChatHeader';

jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Ionicons: ({ name, color }: { name: string; color: string }) =>
      mockReact.createElement(MockText, { color }, name),
  };
});

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll' | 'parent'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  parent: QueryableInstance | null;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
  findByType(type: React.ElementType): QueryableInstance;
};

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Synthetic glyph width used to model title layout so the scroll math stays deterministic. */
const CHAR_WIDTH = 9;

function wrap(node: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <AppThemeProvider theme={theme}>{node}</AppThemeProvider>
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
  return tree.root as unknown as QueryableInstance;
}

function textContent(node: QueryableInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function hostNodes(root: QueryableInstance): QueryableInstance[] {
  return root.findAll((node) => typeof node.type === 'string');
}

function findHost(root: QueryableInstance, label: string): QueryableInstance {
  const match = hostNodes(root).find((node) => node.props['accessibilityLabel'] === label);
  if (!match) {
    throw new Error(`Missing host node: ${label}`);
  }
  return match;
}

function queryHost(root: QueryableInstance, label: string): QueryableInstance | null {
  return hostNodes(root).find((node) => node.props['accessibilityLabel'] === label) ?? null;
}

function findToolbarButton(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll(
    (node) => node.type === CircularToolbarButton && node.props['accessibilityLabel'] === label,
  )[0];
  if (!match) {
    throw new Error(`Missing circular toolbar button: ${label}`);
  }
  return match;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') {
    throw new Error(`Missing callback: ${name}`);
  }
  return (callback as (...callbackArgs: unknown[]) => unknown)(...args);
}

/** The native scroll view backing the header title. */
function titleScrollHost(root: QueryableInstance): QueryableInstance {
  const match = hostNodes(root).find((node) => node.type === 'RCTScrollView');
  if (!match) {
    throw new Error('Title scroll view is not rendered');
  }
  return match;
}

/**
 * Ancestors that grab the touch before the title scroll view can see it. A `Pressable` wrapper
 * shows up here, which is exactly what used to swallow the title tap and the drag gesture.
 */
function touchClaimingAncestors(node: QueryableInstance): QueryableInstance[] {
  const claimers: QueryableInstance[] = [];
  let current = node.parent;
  while (current) {
    if (
      typeof current.type === 'string' &&
      typeof current.props['onStartShouldSetResponder'] === 'function'
    ) {
      claimers.push(current);
    }
    current = current.parent;
  }
  return claimers;
}

function pressAncestors(node: QueryableInstance): QueryableInstance[] {
  const pressables: QueryableInstance[] = [];
  let current = node.parent;
  while (current) {
    if (typeof current.props['onPress'] === 'function') {
      pressables.push(current);
    }
    current = current.parent;
  }
  return pressables;
}

function touchEvent() {
  const timestamp = Date.now();
  return {
    nativeEvent: {
      pageX: 10,
      pageY: 10,
      locationX: 4,
      locationY: 4,
      timestamp,
      touches: [],
      changedTouches: [],
      identifier: 1,
      target: 1,
    },
    currentTarget: {
      measure: (callback: (...args: number[]) => void) => callback(0, 0, 30, 30, 100, 40),
    },
    persist: () => undefined,
    dispatchConfig: {},
    target: 1,
    touchHistory: {
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: timestamp,
      numberActiveTouches: 1,
      touchBank: [],
    },
  };
}

/** Drives the responder handshake a real finger tap performs instead of calling `onPress`. */
function tapHost(node: QueryableInstance): void {
  const shouldSet = node.props['onStartShouldSetResponder'];
  if (typeof shouldSet !== 'function' || (shouldSet as () => boolean)() !== true) {
    throw new Error('Node does not accept touches');
  }
  act(() => {
    invokeProp(node, 'onResponderGrant', touchEvent());
    invokeProp(node, 'onResponderRelease', touchEvent());
    jest.runOnlyPendingTimers();
  });
}

interface ScrollSimulator {
  offset: () => number;
  maxOffset: () => number;
  /** Positive `distance` drags the finger leftwards, revealing text further right. */
  drag: (distance: number) => number;
  visibleText: () => string;
  seenText: () => string;
}

/**
 * Emulates a real horizontal pan on the title: layout is reported, the drag is refused when an
 * ancestor would claim the touch first, and the clamped offsets are pushed back through the
 * component's own `onScroll` handler.
 */
function createTitleScroller(
  tree: ReactTestRenderer,
  options: { title: string; viewportWidth: number },
): ScrollSimulator {
  const { title, viewportWidth } = options;
  const contentWidth = title.length * CHAR_WIDTH;
  let offset = 0;
  const seen = new Set<number>();

  const host = () => titleScrollHost(queryRoot(tree));
  const maxOffset = () => Math.max(0, contentWidth - viewportWidth);

  const visibleRange = () => {
    const start = Math.floor(offset / CHAR_WIDTH);
    const end = Math.min(title.length, Math.ceil((offset + viewportWidth) / CHAR_WIDTH));
    return [start, end] as const;
  };

  const recordVisible = () => {
    const [start, end] = visibleRange();
    for (let index = start; index < end; index += 1) {
      seen.add(index);
    }
  };

  const emit = (nextOffset: number) => {
    offset = nextOffset;
    act(() => {
      const onScroll = host().props['onScroll'];
      if (typeof onScroll === 'function') {
        invokeProp(host(), 'onScroll', {
          nativeEvent: {
            contentOffset: { x: offset, y: 0 },
            contentSize: { width: contentWidth, height: 24 },
            layoutMeasurement: { width: viewportWidth, height: 24 },
          },
        });
      }
    });
    recordVisible();
  };

  act(() => {
    if (typeof host().props['onLayout'] === 'function') {
      invokeProp(host(), 'onLayout', { nativeEvent: { layout: { width: viewportWidth } } });
    }
    if (typeof host().props['onContentSizeChange'] === 'function') {
      invokeProp(host(), 'onContentSizeChange', contentWidth, 24);
    }
  });
  recordVisible();

  return {
    offset: () => offset,
    maxOffset,
    drag: (distance: number) => {
      const scrollHost = host();
      const claimers = touchClaimingAncestors(scrollHost);
      if (claimers.length > 0) {
        throw new Error(
          `Title drag was intercepted by ${claimers.length} touch-claiming ancestor(s): ` +
            claimers
              .map((node) => String(node.props['accessibilityLabel'] ?? node.type))
              .join(', '),
        );
      }
      if (scrollHost.props['horizontal'] !== true) {
        throw new Error('Title does not scroll horizontally');
      }
      if (scrollHost.props['scrollEnabled'] === false) {
        throw new Error('Title scrolling is disabled');
      }

      // A finger pan lands as several throttled scroll events, not one jump.
      const target = Math.min(Math.max(offset + distance, 0), maxOffset());
      const steps = 4;
      for (let step = 1; step <= steps; step += 1) {
        emit(offset + (target - offset) / (steps - step + 1));
      }
      emit(target);
      return offset;
    },
    visibleText: () => {
      const [start, end] = visibleRange();
      return title.slice(start, end);
    },
    seenText: () =>
      title
        .split('')
        .map((char, index) => (seen.has(index) ? char : ''))
        .join(''),
  };
}

function gradients(root: QueryableInstance): QueryableInstance[] {
  return root.findAll((node) => node.type === 'LinearGradient');
}

const LONG_TITLE = 'Refactor the bridge session lifecycle and rename handling end to end';

describe('ChatHeader', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the title and wires the drawer, rename, and right actions', () => {
    const onOpenDrawer = jest.fn();
    const onRenameTitle = jest.fn();
    const onRightActionPress = jest.fn();
    const tree = render(
      <ChatHeader
        onOpenDrawer={onOpenDrawer}
        title="  A very long chat title  "
        onRenameTitle={onRenameTitle}
        rightIconName="git-branch-outline"
        onRightActionPress={onRightActionPress}
      />,
    );
    const root = queryRoot(tree);

    expect(textContent(root)).toContain('A very long chat title');
    tapHost(findHost(root, 'Open navigation drawer'));
    tapHost(findHost(root, 'Edit session title'));
    tapHost(findHost(root, 'Open Git'));

    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    expect(onRenameTitle).toHaveBeenCalledTimes(1);
    expect(onRightActionPress).toHaveBeenCalledTimes(1);
    expect(findToolbarButton(root, 'Edit session title')).toBeDefined();
    act(() => tree.unmount());
  });

  it('keeps header controls available with active native glass', () => {
    const originalPlatformOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);
    const tree = render(
      <ChatHeader
        onOpenDrawer={jest.fn()}
        title={LONG_TITLE}
        onRenameTitle={jest.fn()}
        rightIconName="git-branch-outline"
        onRightActionPress={jest.fn()}
      />,
    );
    const root = queryRoot(tree);

    expect(tree.root.findByProps({ testID: 'chat-header-glass-surface' })).toBeTruthy();
    expect(getRenderedGlassViewProps().at(-1)?.glassEffectStyle).toBe(
      theme.glass.chrome.glassEffectStyle,
    );
    expect(findHost(root, 'Open navigation drawer')).toBeTruthy();
    expect(findHost(root, 'Edit session title')).toBeTruthy();
    expect(findHost(root, 'Open Git')).toBeTruthy();

    act(() => tree.unmount());
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
  });

  it('exposes rename as a 48pt pencil toolbar button beside the title', () => {
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={jest.fn()} />,
    );
    const root = queryRoot(tree);
    const editButton = findHost(root, 'Edit session title');

    expect(textContent(editButton)).toBe('pencil');
    expect(editButton.props['accessibilityRole']).toBe('button');
    expect(editButton.props['accessibilityHint']).toBe('Opens the rename form for this session');
    expect(findToolbarButton(root, 'Edit session title')).toBeDefined();
    // The old chat-options chevron menu is gone; renaming is the only header title action.
    expect(textContent(root)).not.toContain('chevron-down');
    expect(queryHost(root, `${LONG_TITLE}, chat options`)).toBeNull();
    act(() => tree.unmount());
  });

  it('uses primary text color for every header toolbar icon', () => {
    const tree = render(
      <ChatHeader
        onOpenDrawer={jest.fn()}
        title="Session"
        onRenameTitle={jest.fn()}
        rightIconName="git-branch-outline"
        onRightActionPress={jest.fn()}
      />,
    );
    const root = queryRoot(tree);

    for (const label of ['Open navigation drawer', 'Edit session title', 'Open Git']) {
      const icon = findToolbarButton(root, label).findAll(
        (node) => node.props['color'] !== undefined,
      )[0];
      expect(icon?.props['color']).toBe(theme.colors.textPrimary);
    }

    act(() => tree.unmount());
  });

  it('vertically centers the scrollable title in the 48pt header rhythm', () => {
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={jest.fn()} />,
    );
    const scrollHost = titleScrollHost(queryRoot(tree));

    expect(StyleSheet.flatten(scrollHost.props['contentContainerStyle'] as never)).toMatchObject({
      minHeight: 48,
      alignItems: 'center',
    });
    act(() => tree.unmount());
  });

  it('hides the rename button when the header has no rename handler', () => {
    const tree = render(<ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} />);
    const root = queryRoot(tree);

    expect(queryHost(root, 'Edit session title')).toBeNull();
    expect(textContent(root)).toContain(LONG_TITLE);
    expect(touchClaimingAncestors(titleScrollHost(root))).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('keeps the title out of any press wrapper so taps and drags reach the scroll view', () => {
    const onRenameTitle = jest.fn();
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={onRenameTitle} />,
    );
    const root = queryRoot(tree);
    const scrollHost = titleScrollHost(root);

    // Regression: a Pressable around the scroll view ate the gesture, so the title tap did nothing.
    expect(touchClaimingAncestors(scrollHost)).toHaveLength(0);
    expect(pressAncestors(scrollHost)).toHaveLength(0);
    expect(typeof scrollHost.props['onStartShouldSetResponder']).not.toBe('function');
    expect(scrollHost.props['horizontal']).toBe(true);
    expect(scrollHost.props['scrollEnabled']).not.toBe(false);
    expect(scrollHost.props['bounces']).toBe(false);

    // Nothing in the title region is pressable, so touching it cannot open the rename sheet.
    const titleText = requireTestValue(
      root.findAll((node) => node.type === 'Text' && textContent(node) === LONG_TITLE)[0],
      'indexed test value',
    );
    expect(titleText).toBeDefined();
    expect(pressAncestors(titleText)).toHaveLength(0);
    expect(touchClaimingAncestors(titleText)).toHaveLength(0);
    expect(onRenameTitle).not.toHaveBeenCalled();

    // The rename button itself still takes touches.
    expect(typeof findHost(root, 'Edit session title').props['onStartShouldSetResponder']).toBe(
      'function',
    );
    act(() => tree.unmount());
  });

  it('drags horizontally until the whole title has been read', () => {
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={jest.fn()} />,
    );
    const scroller = createTitleScroller(tree, { title: LONG_TITLE, viewportWidth: 180 });

    expect(scroller.maxOffset()).toBeGreaterThan(0);
    expect(scroller.visibleText()).toBe(LONG_TITLE.slice(0, 20));
    expect(scroller.seenText()).not.toBe(LONG_TITLE);

    let drags = 0;
    while (scroller.offset() < scroller.maxOffset() && drags < 50) {
      scroller.drag(120);
      drags += 1;
    }

    expect(drags).toBeLessThan(50);
    expect(scroller.offset()).toBe(scroller.maxOffset());
    expect(scroller.visibleText()).toBe(LONG_TITLE.slice(-20));
    expect(scroller.seenText()).toBe(LONG_TITLE);
    act(() => tree.unmount());
  });

  it('clamps drags at both ends of the title', () => {
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={jest.fn()} />,
    );
    const scroller = createTitleScroller(tree, { title: LONG_TITLE, viewportWidth: 180 });

    expect(scroller.drag(-400)).toBe(0);
    expect(scroller.drag(90)).toBe(90);
    expect(scroller.drag(-30)).toBe(60);
    expect(scroller.drag(10_000)).toBe(scroller.maxOffset());
    expect(scroller.drag(10_000)).toBe(scroller.maxOffset());
    expect(scroller.drag(-10_000)).toBe(0);
    expect(scroller.visibleText()).toBe(LONG_TITLE.slice(0, 20));
    act(() => tree.unmount());
  });

  it('does not paint opaque overflow fades over the glass while the title is dragged', () => {
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={jest.fn()} />,
    );
    const root = queryRoot(tree);
    const scroller = createTitleScroller(tree, { title: LONG_TITLE, viewportWidth: 180 });

    expect(gradients(root)).toHaveLength(0);

    scroller.drag(120);
    expect(gradients(root)).toHaveLength(0);

    scroller.drag(scroller.maxOffset());
    expect(scroller.offset()).toBe(scroller.maxOffset());
    expect(gradients(root)).toHaveLength(0);

    scroller.drag(-scroller.maxOffset());
    expect(scroller.offset()).toBe(0);
    expect(gradients(root)).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('leaves a short title unscrollable and unfaded', () => {
    const title = 'Short';
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={title} onRenameTitle={jest.fn()} />,
    );
    const root = queryRoot(tree);
    const scroller = createTitleScroller(tree, { title, viewportWidth: 180 });

    expect(scroller.maxOffset()).toBe(0);
    expect(scroller.drag(400)).toBe(0);
    expect(gradients(root)).toHaveLength(0);
    expect(scroller.seenText()).toBe(title);
    act(() => tree.unmount());
  });

  it('rewinds the scroll position when the session is renamed', () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
    const onRenameTitle = jest.fn();
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={onRenameTitle} />,
    );
    const root = queryRoot(tree);
    const scroller = createTitleScroller(tree, { title: LONG_TITLE, viewportWidth: 180 });

    scroller.drag(scroller.maxOffset());
    expect(gradients(root)).toHaveLength(0);
    scrollTo.mockClear();

    const renamed = `${LONG_TITLE} (renamed)`;
    act(() => {
      tree.update(
        wrap(<ChatHeader onOpenDrawer={jest.fn()} title={renamed} onRenameTitle={onRenameTitle} />),
      );
    });

    expect(scrollTo).toHaveBeenCalledWith({ x: 0, animated: false });
    expect(textContent(queryRoot(tree))).toContain(renamed);
    expect(gradients(queryRoot(tree))).toHaveLength(0);

    const rewound = createTitleScroller(tree, { title: renamed, viewportWidth: 180 });
    expect(rewound.offset()).toBe(0);
    expect(rewound.visibleText()).toBe(renamed.slice(0, 20));
    scrollTo.mockRestore();
    act(() => tree.unmount());
  });

  it('does not add opaque overflow fades after a title update', () => {
    const tree = render(
      <ChatHeader onOpenDrawer={jest.fn()} title={LONG_TITLE} onRenameTitle={jest.fn()} />,
    );
    const root = queryRoot(tree);
    expect(gradients(root)).toHaveLength(0);

    act(() => {
      tree.update(
        wrap(
          <ChatHeader
            onOpenDrawer={jest.fn()}
            title={`${LONG_TITLE} (updated)`}
            onRenameTitle={jest.fn()}
          />,
        ),
      );
    });
    expect(gradients(queryRoot(tree))).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('falls back to a placeholder title and renders a static right icon', () => {
    const tree = render(<ChatHeader onOpenDrawer={jest.fn()} title="   " rightIconName="search" />);
    expect(textContent(queryRoot(tree))).toContain('New chat');
    expect(queryHost(queryRoot(tree), 'Open Git')).toBeNull();
    expect(textContent(queryRoot(tree))).toContain('search');

    act(() => {
      tree.update(wrap(<ChatHeader onOpenDrawer={jest.fn()} title="Plain" />));
    });
    expect(textContent(queryRoot(tree))).toContain('Plain');
    act(() => tree.unmount());
  });

  it('lays out every header action as an aligned 48pt circular toolbar control', () => {
    const tree = render(
      <ChatHeader
        onOpenDrawer={jest.fn()}
        title={LONG_TITLE}
        onRenameTitle={jest.fn()}
        rightIconName="git-branch-outline"
        onRightActionPress={jest.fn()}
      />,
    );
    const root = queryRoot(tree);

    expect(
      ['Open navigation drawer', 'Edit session title', 'Open Git'].map(
        (label) => findToolbarButton(root, label).type,
      ),
    ).toEqual([CircularToolbarButton, CircularToolbarButton, CircularToolbarButton]);
    expect(
      StyleSheet.flatten(
        requireTestValue(
          root.findAll((node) => node.props['testID'] === 'chat-header-actions')[0],
          'chat header actions',
        ).props['style'] as never,
      ),
    ).toMatchObject({
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    });
    expect(
      StyleSheet.flatten(
        requireTestValue(
          root.findAll((node) => node.props['testID'] === 'chat-header-row')[0],
          'chat header row',
        ).props['style'] as never,
      ),
    ).toMatchObject({
      paddingHorizontal: theme.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
    });
    // The title zone must shrink instead of pushing the agent icon under the trailing
    // actions, which previously made the rename glyph overlap the agent chip.
    expect(
      StyleSheet.flatten(
        requireTestValue(
          root.findAll((node) => node.props['testID'] === 'chat-header-title-row')[0],
          'chat header title row',
        ).props['style'] as never,
      ),
    ).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
    });
    act(() => tree.unmount());
  });
});
