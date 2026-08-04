import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ActivityEvent, type ActivityTone } from './ActivityEvent';
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

function render(tone: ActivityTone, title: string, detail?: string | null): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <ActivityEvent tone={tone} title={title} detail={detail} />
      </AppThemeProvider>,
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

function glyphNodes(tree: ReactTestRenderer): Queryable[] {
  return allNodes(tree).filter((node) => node.props['testID'] === 'atom-glyph');
}

describe('ActivityEvent', () => {
  it('renders as a high-contrast transcript row instead of a glass surface', () => {
    const tree = render('idle', 'Waiting for input');

    expect(textContent(tree.root as Queryable)).toContain('Waiting for input');
    expect(tree.root.findByProps({ testID: 'transcript-activity-event' })).toBeTruthy();
    expect(
      flattenedStyles(tree).some(
        (style) =>
          style['fontSize'] === theme.typography.label.fontSize &&
          style['color'] === theme.colors.textPrimary,
      ),
    ).toBe(true);
    act(() => tree.unmount());
  });

  it('keeps the activity verb and detail together for every tone', () => {
    for (const tone of ['running', 'error'] as const) {
      const tree = render(tone, tone === 'running' ? 'Editing file' : 'Turn failed', 'src/main.ts');
      expect(textContent(tree.root as Queryable)).toContain(
        `${tone === 'running' ? 'Editing file' : 'Turn failed'} · src/main.ts`,
      );
      act(() => tree.unmount());
    }
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

  it('spins an atom while running and shows a settled icon otherwise', () => {
    // A live turn used to get the same three static-looking bars as every other loading
    // surface; the running row is now the only one with the animated atom.
    const running = render('running', 'Working');
    expect(glyphNodes(running)).not.toHaveLength(0);
    expect(iconNames(running)).toHaveLength(0);
    act(() => running.unmount());

    const settled: [ActivityTone, string][] = [
      ['complete', 'checkmark-circle-outline'],
      ['error', 'close-circle-outline'],
      ['idle', 'ellipse-outline'],
    ];
    for (const [tone, icon] of settled) {
      const tree = render(tone, 'Status');
      expect(glyphNodes(tree)).toHaveLength(0);
      expect(iconNames(tree)).toContain(icon);
      act(() => tree.unmount());
    }
  });
});
