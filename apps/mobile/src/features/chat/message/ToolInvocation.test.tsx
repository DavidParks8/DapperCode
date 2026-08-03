import { requireTestValue } from '@shared/testing/requireTestValue';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ToolInvocationRow } from './ToolInvocation';
import type { ToolInvocation } from './toolInvocationModel';
import {
  LinearTransition,
  ReduceMotion,
  setMockReducedMotionEnabled,
} from '@shared/testing/reanimatedMock';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => name,
}));

type Queryable = ReactTestInstance & {
  parent: Queryable | null;
  props: Record<string, unknown>;
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
    .map((node) => node.props['children'])
    .filter((child): child is string => typeof child === 'string');
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

  it('uses the full transcript width for expanded tool content', () => {
    const value = invocation({ id: 'tool-full-width', textLines: ['output'] });
    const tree = render(value);
    expand(tree, value.title);
    const panel = requireTestValue(
      tree.root.findAllByProps({ testID: 'tool-output-panel' })[0],
      'tool output panel',
    );

    expect(StyleSheet.flatten(panel.props['style'] as object)).not.toHaveProperty('marginLeft');

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

    expect(lines).toContain('- const a = 1;');
    expect(lines).toContain('+ const a = 2;');
    expect(lines).toContain('+ export {};');
    expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(1);
    expect(tree.root.findAllByProps({ testID: 'tool-output-panel' }).length).toBeGreaterThan(0);

    act(() => tree.unmount());
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
    expect(tree.root.findAllByProps({ testID: 'tool-diff-overflow-fade' })).not.toHaveLength(0);

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
});
