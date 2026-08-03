import { requireTestValue } from '@shared/testing/requireTestValue';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ToolInvocationRow } from './ToolInvocation';
import { createToolCardStyles } from './toolCardStyles';
import type { ToolInvocation } from './toolInvocationModel';
import {
  LinearTransition,
  ReduceMotion,
  setMockReducedMotionEnabled,
} from '@shared/testing/reanimatedMock';
import { compositeOverlayColor } from './useHorizontalOverflow';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => name,
}));

type Queryable = ReactTestInstance & {
  children: Array<Queryable | string | number>;
  parent: Queryable | null;
  props: Record<string, unknown>;
  type: unknown;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByProps(props: Record<string, unknown>): Queryable[];
  findAllByType(type: unknown): Queryable[];
};
type QueryableRenderer = ReactTestRenderer & { root: Queryable; toJSON(): unknown };

const theme = createAppTheme('dark');

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    id: 'tool-1',
    kind: 'other',
    status: 'completed',
    title: 'Did a thing',
    statusLanguage: true,
    monospaceTitle: false,
    isError: false,
    locations: [],
    diffs: [],
    terminals: [],
    textLines: [],
    images: [],
    truncated: false,
    empty: false,
    ...overrides,
  };
}

function render(
  value: ToolInvocation,
  bridgeUrl: string | null = null,
  threadRunning = true,
): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 59, right: 0, bottom: 34, left: 0 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <ToolInvocationRow
            invocation={value}
            bridgeUrl={bridgeUrl}
            bridgeToken={null}
            threadRunning={threadRunning}
          />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected a rendered row');
  }
  return tree as QueryableRenderer;
}

function expand(tree: QueryableRenderer, title: string) {
  const control = tree.root.findAll(
    (node) =>
      typeof node.props['onPress'] === 'function' && node.props['accessibilityLabel'] === title,
  )[0];
  if (!control) {
    throw new Error('Missing invocation row');
  }
  act(() => {
    (control.props['onPress'] as () => void)();
  });
}

function textLines(tree: QueryableRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .filter((node) => !hasTextAncestor(node))
    .map((node) => flattenTestText(node))
    .filter(Boolean);
}

function flattenTestText(node: Queryable): string {
  return node.children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : flattenTestText(child),
    )
    .join('');
}

function hasTextAncestor(node: Queryable): boolean {
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.type === Text || ancestor.type === 'Text') {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function hexColorDistance(left: string, right: string): number {
  const channels = (hex: string) =>
    [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const leftChannels = channels(left);
  const rightChannels = channels(right);
  return Math.hypot(
    (leftChannels[0] ?? 0) - (rightChannels[0] ?? 0),
    (leftChannels[1] ?? 0) - (rightChannels[1] ?? 0),
    (leftChannels[2] ?? 0) - (rightChannels[2] ?? 0),
  );
}

function ancestorTestIDs(node: Queryable): string[] {
  const testIDs: string[] = [];
  let ancestor = node.parent;
  while (ancestor) {
    const testID = ancestor.props['testID'];
    if (typeof testID === 'string') {
      testIDs.push(testID);
    }
    ancestor = ancestor.parent;
  }
  return testIDs;
}

function layout(node: Queryable, size: { width: number; height: number }): void {
  const onLayout = node.props['onLayout'] as (event: {
    nativeEvent: { layout: { width: number; height: number } };
  }) => void;
  act(() => {
    onLayout({ nativeEvent: { layout: size } });
  });
}

/** Text nodes rendered by the shimmer overlay, which must be recolored copies of the header. */
function highlightCopies(shimmer: Queryable): Queryable[] {
  return shimmer
    .findAllByType(Text)
    .filter((node) => !hasTextAncestor(node))
    .filter(
      (node) =>
        (StyleSheet.flatten(node.props['style'] as object) as { color?: string } | undefined)
          ?.color === theme.colors.textPrimary,
    );
}

/** Any surface inside the shimmer that would tint the row instead of the glyphs. */
function paintedBackgrounds(shimmer: Queryable): unknown[] {
  return shimmer
    .findAll((node) => typeof node.type === 'string')
    .map((node) => StyleSheet.flatten(node.props['style'] as object) as Record<string, unknown>)
    .filter((style) => Boolean(style?.['backgroundColor'] ?? style?.['colors']));
}

function clippingWindows(shimmer: Queryable): Queryable[] {
  return hostNodes(shimmer, 'tool-header-shimmer-window').filter(
    (node) =>
      (StyleSheet.flatten(node.props['style'] as object) as { overflow?: string } | undefined)
        ?.overflow === 'hidden',
  );
}

function shimmerCopies(shimmer: Queryable): Queryable[] {
  return hostNodes(shimmer, 'tool-header-shimmer-copy');
}

/** react-test-renderer surfaces both the composite and its host view, so keep only hosts. */
function hostNodes(root: Queryable, testID: string): Queryable[] {
  return root.findAll((node) => typeof node.type === 'string' && node.props['testID'] === testID);
}

function transformShift(node: Queryable): number {
  const style = StyleSheet.flatten(node.props['style'] as object) as {
    transform?: [{ translateX: number }];
  };
  return style.transform?.[0]?.translateX ?? 0;
}

function hexContrastRatio(left: string, right: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
  };
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

describe('ToolInvocationRow', () => {
  afterEach(() => setMockReducedMotionEnabled(false));

  it('marks a pending tool with a waiting affordance', () => {
    const tree = render(invocation({ id: 'tool-pending', status: 'pending', empty: true }));

    expect(JSON.stringify(tree.toJSON())).toContain('ellipsis-horizontal');
    expect(tree.root.findAllByProps({ testID: 'tool-header-shimmer' })).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('uses a pointer-inert header shimmer only while a tool is actively running', () => {
    const running = render(
      invocation({ id: 'tool-running', kind: 'read', status: 'in_progress', title: 'Read app.ts' }),
    );
    const shimmer = running.root.findByProps({ testID: 'tool-header-shimmer' });
    expect(shimmer.props['pointerEvents']).toBe('none');
    expect(shimmer.props['accessibilityElementsHidden']).toBe(true);
    expect(running.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    act(() => running.unmount());

    const settled = render(
      invocation({ id: 'tool-stale', kind: 'execute', status: 'in_progress', title: 'npm test' }),
      null,
      false,
    );
    expect(settled.root.findAllByProps({ testID: 'tool-header-shimmer' })).toHaveLength(0);
    expect(settled.root.findByProps({ testID: 'tool-row' }).props['accessibilityLabel']).toBe(
      'Ran npm test',
    );
    act(() => settled.unmount());
  });

  it('uses a non-traveling shimmer treatment when Reduce Motion is enabled', () => {
    setMockReducedMotionEnabled(true);
    const tree = render(
      invocation({ id: 'tool-reduced-shimmer', status: 'in_progress', title: 'Read app.ts' }),
    );
    const shimmer = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-header-shimmer' })[0],
      'reduced-motion shimmer',
    );
    const animatedBand = requireTestValue(
      shimmer.findAll(
        (node) =>
          Array.isArray(node.props['style']) &&
          node.props['style'].some(
            (style: unknown) =>
              Boolean(style) && typeof style === 'object' && 'opacity' in (style as object),
          ),
      )[0],
      'animated shimmer band',
    );
    const animatedStyle = (animatedBand.props['style'] as unknown[]).find(
      (style) => style !== null && typeof style === 'object' && 'opacity' in style,
    ) as { opacity: number; transform?: unknown };
    expect(animatedStyle.opacity).toBeGreaterThan(0);
    expect(animatedStyle.transform).toBeUndefined();
    expect(highlightCopies(shimmer).map(flattenTestText)).toEqual(['Read app.ts']);
    expect(paintedBackgrounds(shimmer)).toEqual([]);
    act(() => tree.unmount());
  });

  it('shimmers the header glyphs instead of painting the row background', () => {
    const tree = render(
      invocation({
        id: 'tool-glyph-shimmer',
        kind: 'read',
        status: 'in_progress',
        title: 'Read app.ts',
      }),
    );
    const shimmer = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-header-shimmer' })[0],
      'header shimmer',
    );
    expect(ancestorTestIDs(shimmer)).toContain('tool-title-toggle');
    expect(highlightCopies(shimmer)).toHaveLength(0);

    layout(shimmer, { width: 220, height: 16 });

    const copies = highlightCopies(shimmer);
    expect(copies.length).toBeGreaterThan(1);
    copies.forEach((copy) => expect(flattenTestText(copy)).toBe('Reading app.ts'));
    expect(paintedBackgrounds(shimmer)).toEqual([]);

    const windows = clippingWindows(shimmer);
    expect(windows).toHaveLength(copies.length);
    const centers = windows.map((window) => {
      const style = StyleSheet.flatten(window.props['style'] as object) as {
        width: number;
        opacity: number;
        transform: [{ translateX: number }];
      };
      expect(style.width).toBeLessThan(220);
      expect(style.opacity).toBeGreaterThan(0);
      expect(style.opacity).toBeLessThan(1);
      expect(style.transform[0].translateX).toBeLessThan(0);
      return style.transform[0].translateX + style.width / 2;
    });
    // Concentric passes keep the highlight symmetrical instead of hard-edged on one side.
    expect(new Set(centers).size).toBe(1);
    act(() => tree.unmount());
  });

  it('keeps the command shimmer aligned with the scrollable monospace header', () => {
    const tree = render(
      invocation({
        id: 'tool-command-shimmer',
        kind: 'execute',
        status: 'in_progress',
        monospaceTitle: true,
        title: 'sleep 90 && echo done',
      }),
    );
    const shimmer = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-header-shimmer' })[0],
      'command shimmer',
    );
    expect(ancestorTestIDs(shimmer)).toContain('tool-command-toggle');

    layout(shimmer, { width: 260, height: 16 });

    const copies = highlightCopies(shimmer);
    expect(copies.length).toBeGreaterThan(1);
    expect(new Set(copies.map(flattenTestText))).toEqual(
      new Set(['Running', 'sleep 90 && echo done']),
    );
    expect(paintedBackgrounds(shimmer)).toEqual([]);
    clippingWindows(shimmer).forEach((window, index) => {
      const copy = requireTestValue(shimmerCopies(shimmer)[index], 'shimmer copy');
      expect(transformShift(window) + transformShift(copy)).toBe(0);
      expect(StyleSheet.flatten(copy.props['style'] as object)).toMatchObject({
        width: 260,
        height: 16,
      });
    });
    act(() => tree.unmount());
  });

  it('gives the collapsed row an effective touch target without inflating its visible chrome', () => {
    const tree = render(invocation({ id: 'tool-hitslop', textLines: ['out'] }));
    const row = requireTestValue(tree.root.findAllByProps({ testID: 'tool-row' })[0], 'tool row');
    expect(StyleSheet.flatten(row.props['style'] as object)).not.toHaveProperty(
      'overflow',
      'hidden',
    );
    const target = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-row-toggle' })[0],
      'tool row toggle',
    );
    const hitSlop = target.props['hitSlop'] as
      { top: number; bottom: number; left: number; right: number } | undefined;
    expect(hitSlop).toBeDefined();
    expect(hitSlop!.top).toBeGreaterThan(0);
    expect(hitSlop!.bottom).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('wires the layout transition to honor the system Reduce Motion setting', () => {
    const reduceMotionSpy = jest.spyOn(LinearTransition, 'reduceMotion');
    const tree = render(invocation({ id: 'tool-reduce-motion', textLines: ['out'] }));

    expect(reduceMotionSpy).toHaveBeenCalledWith(ReduceMotion.System);

    reduceMotionSpy.mockRestore();
    act(() => tree.unmount());
  });

  it('animates expand/collapse without throwing, and the transition config is reduce-motion aware', () => {
    const value = invocation({ id: 'tool-animated', textLines: ['out'] });
    const tree = render(value);

    // Toggling twice exercises both the entering and exiting animation branches without crashing;
    // this is the regression the mocked reanimated layer protects against.
    expand(tree, value.title);
    expect(textLines(tree)).toContain('out');
    expand(tree, value.title);
    expect(textLines(tree)).not.toContain('out');

    act(() => tree.unmount());
  });

  it('only highlights the press state while the row can actually expand', () => {
    const open = render(invocation({ id: 'tool-pressable', textLines: ['out'] }));
    const openStyle = requireTestValue(
      open.root.findAllByProps({ testID: 'tool-row-toggle' })[0],
      'indexed test value',
    ).props['style'] as (state: { pressed: boolean }) => unknown[];
    expect(StyleSheet.flatten(openStyle({ pressed: true }) as object)).toHaveProperty(
      'backgroundColor',
    );
    expect(StyleSheet.flatten(openStyle({ pressed: false }) as object)).not.toHaveProperty(
      'backgroundColor',
    );
    act(() => open.unmount());

    const closed = render(invocation({ id: 'tool-inert', empty: true }));
    const closedStyle = requireTestValue(
      closed.root.findAllByProps({ testID: 'tool-row-toggle' })[0],
      'indexed test value',
    ).props['style'] as (state: { pressed: boolean }) => unknown[];
    expect(StyleSheet.flatten(closedStyle({ pressed: true }) as object)).not.toHaveProperty(
      'backgroundColor',
    );
    act(() => closed.unmount());
  });

  it('keeps a stable horizontally scrollable command header when expanded', () => {
    const value = invocation({
      id: 'tool-mono',
      kind: 'execute',
      monospaceTitle: true,
      title: 'npm run test -- --coverage',
      textLines: ['ok'],
    });
    const tree = render(value);

    expect(tree.root.findAllByProps({ testID: 'tool-command-scroll' }).length).toBeGreaterThan(0);
    const commandScroll = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-command-scroll' })[0],
      'command scroll',
    );
    const commandToggle = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-command-toggle' })[0],
      'command toggle',
    );
    expect(
      StyleSheet.flatten(commandScroll.props['contentContainerStyle'] as object),
    ).toMatchObject({
      flexGrow: 1,
    });
    const commandToggleStyle = commandToggle.props['style'] as (state: {
      pressed: boolean;
    }) => object[];
    expect(StyleSheet.flatten(commandToggleStyle({ pressed: false }))).toMatchObject({
      flexGrow: 1,
    });

    expand(tree, value.title);
    expect(tree.root.findAllByProps({ testID: 'tool-command-scroll' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'tool-output-panel' }).length).toBeGreaterThan(0);
    expect(textLines(tree).filter((line) => line === value.title)).toHaveLength(1);

    act(() => tree.unmount());
  });

  it('keeps a collapsed row on one line for multi-line titles', () => {
    const command = 'cd apps/mobile\ngrep -rn "tool" src\necho done';
    const value = invocation({
      id: 'tool-multiline-command',
      kind: 'execute',
      monospaceTitle: true,
      title: command,
      textLines: ['ok'],
    });
    const tree = render(value);

    const collapsedTitle = tree.root
      .findAllByType(Text)
      .find((node) => node.props['children'] === 'cd apps/mobile grep -rn "tool" src echo done');
    expect(collapsedTitle?.props['numberOfLines']).toBe(1);
    expect(collapsedTitle?.props['children']).toBe('cd apps/mobile grep -rn "tool" src echo done');

    expand(tree, command);
    expect(tree.root.findAllByProps({ testID: 'tool-command-scroll' }).length).toBeGreaterThan(0);

    act(() => tree.unmount());
  });

  it('puts the command press target inside the scroll view with no pressable ancestor', () => {
    const value = invocation({
      id: 'tool-gesture',
      kind: 'execute',
      monospaceTitle: true,
      title: 'npm run test -- --coverage',
      textLines: ['ok'],
    });
    const tree = render(value);
    const scroll = tree.root.findByProps({ testID: 'tool-command-scroll' });
    let ancestor: Queryable | null = (scroll as Queryable).parent;
    while (ancestor) {
      expect(typeof ancestor.props['onPress']).not.toBe('function');
      ancestor = ancestor.parent;
    }
    const toggle = scroll.findByProps({ testID: 'tool-command-toggle' });
    expect(typeof toggle.props['onPress']).toBe('function');
    const accessibleRow = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-row' })[0],
      'tool accessibility row',
    );
    expect(accessibleRow.props['accessibilityRole']).toBe('button');
    expect(toggle.props['accessible']).toBe(false);

    act(() => tree.unmount());
  });

  it('keeps a collapsed prose row on one line', () => {
    const title = 'Read a file\nwith a wrapped description';
    const value = invocation({ id: 'tool-multiline-prose', title, textLines: ['ok'] });
    const tree = render(value);

    const collapsedTitle = tree.root
      .findAllByType(Text)
      .find((node) => typeof node.props['children'] === 'string');
    expect(collapsedTitle?.props['numberOfLines']).toBe(1);
    expect(collapsedTitle?.props['children']).toBe('Read a file with a wrapped description');

    act(() => tree.unmount());
  });
});

describe('ToolInvocationOutput', () => {
  it('renders a location chip when the header does not already contain it', () => {
    const value = invocation({
      id: 'tool-read',
      kind: 'read',
      locations: [{ path: 'README.md' }],
      textLines: ['# Title'],
    });
    const tree = render(value);
    expand(tree, value.title);

    expect(textLines(tree)).toContain('README.md');

    act(() => tree.unmount());
  });

  it('aligns expanded tool content to the icon column', () => {
    const value = invocation({ id: 'tool-full-width', textLines: ['output'] });
    const tree = render(value);
    expand(tree, value.title);
    const panel = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-output-panel' })[0],
      'tool output panel',
    );

    expect(StyleSheet.flatten(panel.props['style'] as object)).toMatchObject({
      marginLeft: theme.spacing.sm,
    });

    act(() => tree.unmount());
  });

  it('does not repeat one bare location already shown in the header', () => {
    const value = invocation({
      id: 'tool-read-location',
      kind: 'read',
      title: 'Read README.md',
      locations: [{ path: 'README.md' }],
      textLines: ['# Title'],
    });
    const tree = render(value);
    expand(tree, value.title);

    expect(textLines(tree)).not.toContain('Locations');
    expect(textLines(tree)).not.toContain('README.md');

    act(() => tree.unmount());
  });

  it.each([
    [
      'Read apps/mobile/src/features/chat/message/ToolOutput.tsx',
      'apps/mobile/src/features/chat/message/ToolOutput.tsx',
    ],
    ['Read src/app.tsx', 'src/app.ts'],
  ])('keeps a location when "%s" does not visibly duplicate "%s"', (title, path) => {
    const value = invocation({
      id: `tool-location-${path}`,
      kind: 'read',
      title,
      locations: [{ path }],
      textLines: ['content'],
    });
    const tree = render(value);
    expand(tree, value.title);

    expect(textLines(tree)).toContain('Locations');
    expect(textLines(tree)).toContain(path);

    act(() => tree.unmount());
  });

  it('shows one truncation note when an unavailable diff is also marked truncated', () => {
    const value = invocation({
      id: 'tool-truncated-diff',
      kind: 'edit',
      truncated: true,
      diffs: [{ path: 'src/a.ts', oldText: 'x'.repeat(16 * 1024), newText: 'replacement' }],
    });
    const tree = render(value);
    expand(tree, value.title);

    expect(textLines(tree).filter((line) => line.startsWith('Diff too large'))).toEqual([
      'Diff too large to display.',
    ]);

    act(() => tree.unmount());
  });

  it('omits removed lines for a newly created file', () => {
    const value = invocation({
      id: 'tool-edit',
      kind: 'edit',
      diffs: [
        { path: 'src/a.ts', oldText: 'const a = 1;\n', newText: 'const a = 2;\n' },
        { path: 'src/new.ts', oldText: null, newText: 'export {};\n' },
      ],
    });
    const tree = render(value);
    expand(tree, value.title);
    const lines = textLines(tree);

    expect(lines).toContain('const a = 1;');
    expect(lines).toContain('const a = 2;');
    expect(lines).toContain('export {};');
    const addedMarkers = tree.root.findAllByProps({ testID: 'tool-diff-marker-add' });
    const removedMarkers = tree.root.findAllByProps({ testID: 'tool-diff-marker-remove' });
    expect(addedMarkers.length).toBeGreaterThanOrEqual(2);
    expect(addedMarkers.every((marker) => marker.props['children'] === '+')).toBe(true);
    expect(removedMarkers.length).toBeGreaterThan(0);
    expect(removedMarkers.every((marker) => marker.props['children'] === '-')).toBe(true);
    expect(
      tree.root.findAllByProps({ accessibilityLabel: '1 line added' }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      tree.root.findAllByProps({ accessibilityLabel: '1 line removed' }).length,
    ).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'tool-output-panel' }).length).toBeGreaterThan(0);

    act(() => tree.unmount());
  });

  it('clips each file diff to a rounded surface and highlights recognized source code', () => {
    const value = invocation({
      id: 'tool-rounded-highlighted-diff',
      kind: 'edit',
      diffs: [
        {
          path: 'src/a.ts',
          oldText: '/**\n * before\n */\nconst label = "before";\n',
          newText: '/**\n * after\n */\nconst label = "after";\n',
        },
        {
          path: 'fixtures/data.unknown',
          oldText: 'const value = 1;\n',
          newText: 'const value = 2;\n',
        },
      ],
    });
    const tree = render(value);
    expand(tree, value.title);
    const blocks = tree.root
      .findAllByType(View)
      .filter((node) => node.props['testID'] === 'tool-diff-block');

    expect(blocks).toHaveLength(2);
    expect(StyleSheet.flatten(blocks[0]?.props['style'] as object)).toMatchObject({
      borderRadius: theme.radius.sm,
      overflow: 'hidden',
    });
    expect(StyleSheet.flatten(blocks[1]?.props['style'] as object)).toMatchObject({
      marginTop: theme.spacing.sm,
    });
    expect(StyleSheet.flatten(createToolCardStyles(theme).diffScrollFrame)).toMatchObject({
      paddingVertical: 2,
    });

    const sourceTokens = blocks[0]?.findAllByType(Text) ?? [];
    const keywords = sourceTokens.filter((node) => node.props['children'] === 'const');
    const strings = sourceTokens.filter((node) => node.props['children'] === '"after"');
    const comments = sourceTokens.filter((node) => node.props['children'] === ' * after');
    expect(keywords).toHaveLength(2);
    expect(strings).not.toHaveLength(0);
    expect(comments).not.toHaveLength(0);
    expect(StyleSheet.flatten(keywords[0]?.props['style'] as object)).toMatchObject({
      color: theme.colors.codeSyntaxKeyword,
    });
    expect(StyleSheet.flatten(comments[0]?.props['style'] as object)).toMatchObject({
      color: theme.colors.codeSyntaxComment,
    });
    expect(blocks[1]?.findAllByType(Text).some((node) => node.props['children'] === 'const')).toBe(
      false,
    );

    for (const palette of [
      createAppTheme('dark', 'classic'),
      createAppTheme('dark', 'grey'),
      createAppTheme('light'),
    ]) {
      const syntaxColors = [
        palette.colors.codeSyntaxComment,
        palette.colors.codeSyntaxKeyword,
        palette.colors.codeSyntaxString,
        palette.colors.codeSyntaxNumber,
        palette.colors.codeSyntaxFunction,
        palette.colors.codeSyntaxProperty,
        palette.colors.codeSyntaxOperator,
      ];
      for (const syntaxColor of syntaxColors) {
        expect(hexColorDistance(syntaxColor, palette.colors.diffAddedText)).toBeGreaterThan(48);
        expect(hexColorDistance(syntaxColor, palette.colors.diffRemovedText)).toBeGreaterThan(48);
        const panelSurface = compositeOverlayColor(
          palette.colors.bgMain,
          palette.colors.bgCanvasAccent,
        );
        const addedSurface = compositeOverlayColor(panelSurface, palette.colors.diffAddedBg);
        const removedSurface = compositeOverlayColor(panelSurface, palette.colors.diffRemovedBg);
        expect(hexContrastRatio(syntaxColor, addedSurface)).toBeGreaterThanOrEqual(4.5);
        expect(hexContrastRatio(syntaxColor, removedSurface)).toBeGreaterThanOrEqual(4.5);
      }
    }

    act(() => tree.unmount());
  });

  it('uses vivid blue and red plus redundant markers for changed lines', () => {
    const value = invocation({
      id: 'tool-color-independent-diff',
      kind: 'edit',
      diffs: [{ path: 'src/a.ts', oldText: 'before', newText: 'after' }],
    });
    const tree = render(value);
    expand(tree, value.title);
    const addedMarker = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-diff-marker-add' })[0],
      'added marker',
    );
    const removedMarker = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-diff-marker-remove' })[0],
      'removed marker',
    );
    const addedStyle = StyleSheet.flatten(addedMarker.props['style'] as object);
    const removedStyle = StyleSheet.flatten(removedMarker.props['style'] as object);

    expect(addedMarker.props['children']).toBe('+');
    expect(addedStyle).toMatchObject({
      color: theme.colors.diffAddedText,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.diffAddedText,
    });
    expect(removedMarker.props['children']).toBe('-');
    expect(removedStyle).toMatchObject({
      color: theme.colors.diffRemovedText,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.diffRemovedText,
    });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Added line: after' })).not.toHaveLength(
      0,
    );
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Removed line: before' }),
    ).not.toHaveLength(0);

    act(() => tree.unmount());

    const lightTheme = createAppTheme('light');
    const lightStyles = createToolCardStyles(lightTheme);
    expect(StyleSheet.flatten(lightStyles.diffLineMarkerAdded)).toMatchObject({
      color: lightTheme.colors.diffAddedText,
      borderLeftColor: lightTheme.colors.diffAddedText,
    });
    expect(StyleSheet.flatten(lightStyles.diffLineMarkerRemoved)).toMatchObject({
      color: lightTheme.colors.diffRemovedText,
      borderLeftColor: lightTheme.colors.diffRemovedText,
    });
  });

  it('renders usable images and skips ones the bridge cannot serve', () => {
    const value = invocation({
      id: 'tool-image',
      images: ['data:image/png;base64,AAAA', 'not-a-usable-source.png'],
    });
    const tree = render(value, 'http://127.0.0.1:8081');
    expand(tree, value.title);

    expect(tree.root.findAllByType(Image)).toHaveLength(1);

    act(() => tree.unmount());
  });

  it('switches to a scroll container once the body outgrows the inline threshold', () => {
    const short = invocation({ id: 'tool-short', textLines: ['one', 'two'] });
    const shortTree = render(short);
    expand(shortTree, short.title);
    expect(shortTree.root.findAllByType(ScrollView)).toHaveLength(0);
    act(() => shortTree.unmount());

    const longOutput = Array.from({ length: 25 }, (_, index) => `line ${String(index)}`).join('\n');
    const long = invocation({
      id: 'tool-long',
      terminals: [{ terminalId: null, output: longOutput }],
    });
    const longTree = render(long);
    expand(longTree, long.title);
    expect(longTree.root.findAllByType(ScrollView)).toHaveLength(1);
    act(() => longTree.unmount());
  });

  it('shows measured overflow fades until horizontal content reaches the end', () => {
    const value = invocation({
      id: 'tool-overflow',
      kind: 'execute',
      monospaceTitle: true,
      title: 'npm run a-very-long-command -- --with-many-options',
      diffs: [{ path: 'src/a.ts', oldText: 'short', newText: 'a very long replacement line' }],
    });
    const tree = render(value);
    const commandScroll = tree.root.findByProps({ testID: 'tool-command-scroll' });
    const commandLayout = commandScroll.props['onLayout'] as (event: {
      nativeEvent: { layout: { width: number } };
    }) => void;
    const commandContentSize = commandScroll.props['onContentSizeChange'] as (
      width: number,
      height: number,
    ) => void;
    act(() => {
      commandLayout({ nativeEvent: { layout: { width: 100 } } });
      commandContentSize(300, 16);
    });
    const commandFade = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-command-overflow-fade' })[0],
      'command overflow fade',
    );
    expect(commandFade.props['start']).toEqual({ x: 0, y: 0.5 });
    expect(commandFade.props['end']).toEqual({ x: 1, y: 0.5 });
    expect(commandFade.props['colors']).toEqual(['rgba(0, 0, 0, 0)', theme.colors.bgMain]);

    expand(tree, value.title);
    const diffScroll = tree.root.findByProps({ testID: 'tool-diff-scroll' });
    const diffLayout = diffScroll.props['onLayout'] as (event: {
      nativeEvent: { layout: { width: number } };
    }) => void;
    const diffContentSize = diffScroll.props['onContentSizeChange'] as (
      width: number,
      height: number,
    ) => void;
    act(() => {
      diffLayout({ nativeEvent: { layout: { width: 100 } } });
      diffContentSize(300, 16);
    });
    const diffFade = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-diff-overflow-fade' })[0],
      'diff overflow fade',
    );
    expect(diffFade.props['colors']).toEqual(['rgba(10, 10, 10, 0)', '#0A0A0A']);

    const scrolledToEnd = { nativeEvent: { contentOffset: { x: 200 } } };
    const commandOnScroll = commandScroll.props['onScroll'] as (
      event: typeof scrolledToEnd,
    ) => void;
    const diffOnScroll = diffScroll.props['onScroll'] as (event: typeof scrolledToEnd) => void;
    act(() => {
      commandOnScroll(scrolledToEnd);
      diffOnScroll(scrolledToEnd);
    });
    expect(tree.root.findAllByProps({ testID: 'tool-command-overflow-fade' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'tool-diff-overflow-fade' })).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('composites the diff overflow fade against the actual panel surface', () => {
    expect(compositeOverlayColor('#DDE7F0', 'rgba(41, 58, 84, 0.09)')).toBe('#CDD7E2');
  });
});
