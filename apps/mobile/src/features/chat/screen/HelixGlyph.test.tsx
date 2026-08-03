import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { HelixGlyph } from './HelixGlyph';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

import * as reanimatedMock from '@shared/testing/reanimatedMock';

const { mockSharedValues, resetMockSharedValues, setMockReducedMotionEnabled } = reanimatedMock;

/** Sample columns per strand, mirroring `NODE_COUNT` in the component. */
const NODE_COUNT = 11;
/** Frame parked under Reduce Motion, mirroring `STATIC_PHASE` in the component. */
const STATIC_PHASE = 0.125;

type Props = Record<string, unknown>;

type Queryable = ReactTestInstance & {
  props: Props;
  findAll(predicate: (node: Queryable) => boolean, options?: { deep: boolean }): Queryable[];
};

function render(node: React.ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(node);
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function nodesWithTestID(tree: ReactTestRenderer, testID: string): Queryable[] {
  return (tree.root as Queryable).findAll((node) => node.props['testID'] === testID, {
    deep: true,
  });
}

function styleOf(tree: ReactTestRenderer, testID: string): Props {
  // `testID` is also a prop of the `HelixGlyph` element itself, so skip the composite node and
  // take the host view that actually carries the style.
  const [style] = nodesWithTestID(tree, testID)
    .map((node) => StyleSheet.flatten(node.props['style'] as never) as Props | undefined)
    .filter((flattened): flattened is Props => Boolean(flattened));
  if (!style) {
    throw new Error(`No styled node found for testID ${testID}`);
  }
  return style;
}

function translateYOf(style: Props): number {
  const transform = style['transform'] as { translateY?: number }[] | undefined;
  const entry = transform?.find((item) => item.translateY !== undefined);
  return entry?.translateY ?? 0;
}

function scaleOf(style: Props): number {
  const transform = style['transform'] as { scale?: number }[] | undefined;
  const entry = transform?.find((item) => item.scale !== undefined);
  return entry?.scale ?? 1;
}

describe('HelixGlyph', () => {
  beforeEach(() => {
    resetMockSharedValues();
    setMockReducedMotionEnabled(false);
  });

  afterEach(() => {
    setMockReducedMotionEnabled(false);
  });

  it('renders both strands in both paint layers for every column', () => {
    const tree = render(<HelixGlyph color="#fff" secondaryColor="#0ff" />);

    for (let index = 0; index < NODE_COUNT; index += 1) {
      for (const part of ['a-near', 'a-far', 'b-near', 'b-far']) {
        expect(nodesWithTestID(tree, `helix-glyph-${part}-${String(index)}`)).not.toHaveLength(0);
      }
    }
    expect(nodesWithTestID(tree, `helix-glyph-a-near-${String(NODE_COUNT)}`)).toHaveLength(0);
    // The connecting rungs were dropped: at 26x14pt they read as mud rather than as DNA.
    expect(nodesWithTestID(tree, 'helix-glyph-rung-0')).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('mirrors the two strands so they cross rather than travel together', () => {
    // The helix only reads as a double helix if the counter-strand is the inverse of the first:
    // opposite vertical offset and opposite depth (so one is near while the other is far).
    const tree = render(<HelixGlyph color="#fff" secondaryColor="#0ff" />);

    for (let index = 0; index < NODE_COUNT; index += 1) {
      const strandA = styleOf(tree, `helix-glyph-a-near-${String(index)}`);
      const strandB = styleOf(tree, `helix-glyph-b-near-${String(index)}`);
      expect(translateYOf(strandB)).toBeCloseTo(-translateYOf(strandA), 5);
      // Depth-driven scale moves in opposition between the strands.
      expect(scaleOf(strandA) + scaleOf(strandB)).toBeCloseTo(0.44 + 1.16, 5);
    }

    act(() => tree.unmount());
  });

  it('shows each strand in exactly one paint layer so the near dot occludes the far one', () => {
    // React Native cannot animate z-order, so each strand is drawn twice and the copy that does
    // not match its current depth is held at zero opacity. Without that, the far dot paints over
    // the near one at every crossing and the rotation reads as two dots bouncing.
    const tree = render(<HelixGlyph color="#fff" secondaryColor="#0ff" />);

    for (let index = 0; index < NODE_COUNT; index += 1) {
      for (const strand of ['a', 'b']) {
        const near = styleOf(tree, `helix-glyph-${strand}-near-${String(index)}`)[
          'opacity'
        ] as number;
        const far = styleOf(tree, `helix-glyph-${strand}-far-${String(index)}`)[
          'opacity'
        ] as number;
        expect(Math.min(near, far)).toBe(0);
        expect(Math.max(near, far)).toBeGreaterThan(0);
      }
      // Exactly one strand occupies the near layer at a time; the other is behind it.
      const nearA = styleOf(tree, `helix-glyph-a-near-${String(index)}`)['opacity'] as number;
      const nearB = styleOf(tree, `helix-glyph-b-near-${String(index)}`)['opacity'] as number;
      expect(nearA > 0).not.toBe(nearB > 0);
    }

    act(() => tree.unmount());
  });

  it('tints the counter-strand separately and falls back to a single tone', () => {
    const twoTone = render(<HelixGlyph color="#ff0000" secondaryColor="#00ff00" />);
    expect(styleOf(twoTone, 'helix-glyph-a-near-0')['backgroundColor']).toBe('#ff0000');
    expect(styleOf(twoTone, 'helix-glyph-a-far-0')['backgroundColor']).toBe('#ff0000');
    expect(styleOf(twoTone, 'helix-glyph-b-near-0')['backgroundColor']).toBe('#00ff00');
    act(() => twoTone.unmount());

    const singleTone = render(<HelixGlyph color="#ff0000" />);
    expect(styleOf(singleTone, 'helix-glyph-b-near-0')['backgroundColor']).toBe('#ff0000');
    act(() => singleTone.unmount());
  });

  it('spins continuously and stops the loop on unmount', () => {
    const cancelSpy = jest.spyOn(reanimatedMock, 'cancelAnimation').mockImplementation(() => {});

    const tree = render(<HelixGlyph color="#fff" />);
    const [phase] = mockSharedValues;
    // The mock resolves animations to their target immediately, so a running loop settles at a
    // full revolution rather than staying at the initial phase.
    expect(phase?.value).toBe(1);

    act(() => tree.unmount());
    expect(cancelSpy).toHaveBeenCalledWith(phase);
    cancelSpy.mockRestore();
  });

  it('holds a legible static frame while Reduce Motion is enabled', () => {
    setMockReducedMotionEnabled(true);
    const tree = render(<HelixGlyph color="#fff" secondaryColor="#0ff" />);

    const [phase] = mockSharedValues;
    // Parked on the chosen static frame, not advanced: a looping helix would have settled at 1.
    expect(phase?.value).toBe(STATIC_PHASE);
    // That frame still spreads the strands across the box instead of collapsing them to a line.
    const offsets = Array.from({ length: NODE_COUNT }, (_, index) =>
      translateYOf(styleOf(tree, `helix-glyph-a-near-${String(index)}`)),
    );
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(4);
    // ...and the strands cross inside the glyph, which is what makes it read as a helix at rest.
    const crossings = Array.from({ length: NODE_COUNT }, (_, index) =>
      translateYOf(styleOf(tree, `helix-glyph-a-near-${String(index)}`)),
    ).filter((offset, index, all) => index > 0 && offset * (all[index - 1] ?? 0) < 0);
    expect(crossings.length).toBeGreaterThan(0);

    act(() => tree.unmount());
  });

  it('keeps the whole helix inside its row-sized box', () => {
    // The glyph shares a short status row, so the strands must not spill past the box and
    // collide with the caption next to it.
    const tree = render(<HelixGlyph color="#fff" testID="row-helix" />);
    const box = styleOf(tree, 'row-helix');
    const halfHeight = (box['height'] as number) / 2;

    for (let index = 0; index < NODE_COUNT; index += 1) {
      const dot = styleOf(tree, `row-helix-a-near-${String(index)}`);
      const radius = ((dot['height'] as number) / 2) * scaleOf(dot);
      expect(Math.abs(translateYOf(dot)) + radius).toBeLessThanOrEqual(halfHeight);
    }

    act(() => tree.unmount());
  });
});
