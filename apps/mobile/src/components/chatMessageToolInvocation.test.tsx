import { Image, ScrollView, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { ToolInvocationRow } from './chatMessageToolInvocation';
import type { ToolInvocation } from './toolInvocationModel';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => name,
}));

type Queryable = ReactTestInstance & {
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

function render(value: ToolInvocation, bridgeUrl: string | null = null): QueryableRenderer {
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
          <ToolInvocationRow invocation={value} bridgeUrl={bridgeUrl} bridgeToken={null} />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) throw new Error('Expected a rendered row');
  return tree as QueryableRenderer;
}

function expand(tree: QueryableRenderer, title: string) {
  const control = tree.root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === title,
  )[0];
  if (!control) throw new Error('Missing invocation row');
  act(() => {
    (control.props.onPress as () => void)();
  });
}

function textLines(tree: QueryableRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('ToolInvocationRow', () => {
  it('marks a pending tool with a waiting affordance', () => {
    const tree = render(invocation({ id: 'tool-pending', status: 'pending', empty: true }));

    expect(JSON.stringify(tree.toJSON())).toContain('ellipsis-horizontal');

    act(() => tree.unmount());
  });

  it('only highlights the press state while the row can actually expand', () => {
    const open = render(invocation({ id: 'tool-pressable', textLines: ['out'] }));
    const openStyle = open.root.findAll(
      (node) => typeof node.props.onPress === 'function',
    )[0].props.style as (state: { pressed: boolean }) => unknown[];
    expect(openStyle({ pressed: true })[2]).toBeTruthy();
    expect(openStyle({ pressed: false })[2]).toBeFalsy();
    act(() => open.unmount());

    const closed = render(invocation({ id: 'tool-inert', empty: true }));
    const closedStyle = closed.root.findAll(
      (node) => typeof node.props.onPress === 'function',
    )[0].props.style as (state: { pressed: boolean }) => unknown[];
    expect(closedStyle({ pressed: true })[2]).toBeFalsy();
    act(() => closed.unmount());
  });

  it('stops scrolling a monospace title once the row is expanded', () => {
    const value = invocation({
      id: 'tool-mono',
      kind: 'execute',
      monospaceTitle: true,
      title: 'npm run test -- --coverage',
      textLines: ['ok'],
    });
    const tree = render(value);

    expect(tree.root.findAllByProps({ testID: 'tool-command-scroll' }).length).toBeGreaterThan(0);

    expand(tree, value.title);
    expect(tree.root.findAllByProps({ testID: 'tool-command-scroll' })).toHaveLength(0);
    const title = tree.root.findAllByType(Text).find((node) => node.props.children === value.title);
    expect(title?.props.numberOfLines).toBe(3);

    act(() => tree.unmount());
  });
});

describe('ToolInvocationOutput', () => {
  it('renders a location chip without a line number', () => {
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

    act(() => tree.unmount());
  });

  it('renders usable images and skips ones the bridge cannot serve', () => {
    const value = invocation({ id: 'tool-image', images: ['data:image/png;base64,AAAA', 'not-a-usable-source.png'] });
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
});
