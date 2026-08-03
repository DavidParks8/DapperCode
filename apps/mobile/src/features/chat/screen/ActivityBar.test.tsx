import React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ActivityBar, type ActivityTone } from './ActivityBar';
import { AppThemeProvider, createAppTheme } from '@shared/theme';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

import { FadeIn, ReduceMotion } from '@shared/testing/reanimatedMock';

type Props = Record<string, unknown>;

type Queryable = ReactTestInstance & {
  children: Array<Queryable | string>;
  props: Props;
  findAll(predicate: (node: Queryable) => boolean, options?: { deep: boolean }): Queryable[];
};

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function render(tone: ActivityTone, title: string, detail?: string | null): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <AppThemeProvider theme={theme}>
          <ActivityBar tone={tone} title={title} detail={detail} />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function textContent(node: Queryable | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children.map((child) => textContent(child)).join('');
}

function allNodes(tree: ReactTestRenderer): Queryable[] {
  return (tree.root as Queryable).findAll(() => true, { deep: true });
}

function flattenedStyles(tree: ReactTestRenderer): Props[] {
  return allNodes(tree)
    .map((node) => StyleSheet.flatten(node.props['style'] as never) as Props | undefined)
    .filter((style): style is Props => Boolean(style));
}

function iconNames(tree: ReactTestRenderer): string[] {
  return allNodes(tree)
    .map((node) => node.props['name'])
    .filter((name): name is string => typeof name === 'string');
}

function helixNodes(tree: ReactTestRenderer): Queryable[] {
  return allNodes(tree).filter((node) => node.props['testID'] === 'helix-glyph');
}

/** Width of the leading glyph slot: the only fixed-width box in the row. */
function glyphSlotWidth(tree: ReactTestRenderer): number {
  const widths = flattenedStyles(tree)
    .map((style) => style['width'])
    .filter((width): width is number => typeof width === 'number');
  return Math.max(...widths);
}

describe('ActivityBar', () => {
  it('renders the status as a bare caption with no card chrome', () => {
    // The status used to sit inside a blurred, bordered card above the composer, which
    // read as a component rather than as supporting text.
    const tree = render('idle', 'Waiting for input');

    expect(textContent(tree.root as Queryable)).toContain('Waiting for input');
    const blurNodes = allNodes(tree).filter(
      (node) => node.props['intensity'] !== undefined || node.props['tint'] !== undefined,
    );
    expect(blurNodes).toHaveLength(0);
    for (const style of flattenedStyles(tree)) {
      expect(style['backgroundColor']).toBeUndefined();
      expect(style['borderWidth']).toBeUndefined();
      expect(style['borderRadius']).toBeUndefined();
    }
    act(() => tree.unmount());
  });

  it('shows the detail alone while running and stacked once settled', () => {
    const running = render('running', 'Working', 'npm test');
    // A live turn shows what it is doing, not the generic title next to it.
    expect(textContent(running.root as Queryable)).toBe('npm test');
    act(() => running.unmount());

    const failed = render('error', 'Turn failed', 'agent exited 1');
    const failedContent = textContent(failed.root as Queryable);
    expect(failedContent).toContain('Turn failed');
    expect(failedContent).toContain('agent exited 1');
    act(() => failed.unmount());
  });

  it('falls back to the title when there is no detail', () => {
    const tree = render('complete', 'Turn completed', '   ');
    expect(textContent(tree.root as Queryable)).toContain('Turn completed');
    act(() => tree.unmount());
  });

  it('wires the enter transition to honor the system Reduce Motion setting', () => {
    const reduceMotionSpy = jest.spyOn(FadeIn, 'reduceMotion');
    const tree = render('running', 'Working');

    expect(reduceMotionSpy).toHaveBeenCalledWith(ReduceMotion.System);

    reduceMotionSpy.mockRestore();
    act(() => tree.unmount());
  });

  it('spins the helix while running and shows a settled icon otherwise', () => {
    // A live turn used to get the same three static-looking bars as every other loading
    // surface; the running row is now the only one with the animated helix.
    const running = render('running', 'Working');
    expect(helixNodes(running)).not.toHaveLength(0);
    expect(iconNames(running)).toHaveLength(0);
    act(() => running.unmount());

    const settled: [ActivityTone, string][] = [
      ['complete', 'checkmark-circle-outline'],
      ['error', 'close-circle-outline'],
      ['idle', 'ellipse-outline'],
    ];
    for (const [tone, icon] of settled) {
      const tree = render(tone, 'Status');
      expect(helixNodes(tree)).toHaveLength(0);
      expect(iconNames(tree)).toContain(icon);
      act(() => tree.unmount());
    }
  });

  it('gives the running row a wider glyph slot than the icon rows', () => {
    // The helix is wider than a 12pt icon, so a shared 14pt slot would clip it.
    const running = render('running', 'Working');
    const idle = render('idle', 'Waiting for input');

    expect(glyphSlotWidth(running)).toBeGreaterThan(glyphSlotWidth(idle));

    act(() => running.unmount());
    act(() => idle.unmount());
  });
});
