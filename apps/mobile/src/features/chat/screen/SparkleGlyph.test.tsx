import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { SparkleGlyph } from './SparkleGlyph';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

import * as reanimatedMock from '@shared/testing/reanimatedMock';

const { mockSharedValues, resetMockSharedValues, setMockReducedMotionEnabled } = reanimatedMock;

/** Motes of dust, mirroring `DUST_COUNT` in the component. */
const DUST_COUNT = 5;
/** Frame parked under Reduce Motion, mirroring `STATIC_PHASE` in the component. */
const STATIC_PHASE = 0.5;
/** Base square that each arm is scaled from, mirroring `ARM_BASE` in the component. */
const ARM_BASE = 10;
/** Half-length of an arm at rest and at full flare, mirroring the component. */
const ARM_MIN = 6.2;
const ARM_MAX = 9.4;
/** Half-width at the waist at rest, mirroring `WAIST_MIN` in the component. */
const WAIST_MIN = 1.3;
/** Where a mote starts its life, mirroring `DUST_ORBIT_START` in the component. */
const DUST_ORBIT_START = 3.4;
const BOX = 20;

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
  // The mock evaluates `useAnimatedStyle` once, during render, which happens before the effect
  // starts the clock. Re-rendering picks up the phase the effect actually left behind, so these
  // assertions describe the animating glyph rather than its untouched first frame.
  act(() => {
    tree?.update(React.cloneElement(node));
  });
  return tree;
}

function nodesWithTestID(tree: ReactTestRenderer, testID: string): Queryable[] {
  return (tree.root as Queryable).findAll((node) => node.props['testID'] === testID, {
    deep: true,
  });
}

function styleOf(tree: ReactTestRenderer, testID: string): Props {
  // `testID` is also a prop of the `SparkleGlyph` element itself, so skip the composite node and
  // take the host view that actually carries the style.
  const [style] = nodesWithTestID(tree, testID)
    .map((node) => StyleSheet.flatten(node.props['style'] as never) as Props | undefined)
    .filter((flattened): flattened is Props => Boolean(flattened));
  if (!style) {
    throw new Error(`No styled node found for testID ${testID}`);
  }
  return style;
}

function transformOf(style: Props): Record<string, number | string>[] {
  return (style['transform'] ?? []) as Record<string, number | string>[];
}

function numberIn(style: Props, key: string): number {
  const entry = transformOf(style).find((item) => item[key] !== undefined);
  return (entry?.[key] as number | undefined) ?? 0;
}

/** The first rotation is the animated one; the trailing 45 degree turn is what forms the lozenge. */
function turnOf(style: Props): number {
  const entry = transformOf(style).find((item) => typeof item['rotate'] === 'string');
  return Number.parseFloat(String(entry?.['rotate'] ?? '0'));
}

/**
 * Distance from the centre to the tip of an arm. A 45 degree turn puts the base square's corners
 * on the axes at `ARM_BASE / sqrt(2)`, and the scale stretches from there.
 */
function armTip(style: Props): number {
  return (Math.max(numberIn(style, 'scaleX'), numberIn(style, 'scaleY')) * ARM_BASE) / Math.SQRT2;
}

function armWaist(style: Props): number {
  return (Math.min(numberIn(style, 'scaleX'), numberIn(style, 'scaleY')) * ARM_BASE) / Math.SQRT2;
}

const moteID = (index: number) => `sparkle-glyph-mote-${String(index)}`;

describe('SparkleGlyph', () => {
  beforeEach(() => {
    resetMockSharedValues();
    setMockReducedMotionEnabled(false);
  });

  afterEach(() => {
    setMockReducedMotionEnabled(false);
  });

  it('draws the sparkle as two crossed arms plus its dust', () => {
    const tree = render(<SparkleGlyph color="#fff" />);

    expect(nodesWithTestID(tree, 'sparkle-glyph-arm-upright')).not.toHaveLength(0);
    expect(nodesWithTestID(tree, 'sparkle-glyph-arm-across')).not.toHaveLength(0);
    for (let index = 0; index < DUST_COUNT; index += 1) {
      expect(nodesWithTestID(tree, moteID(index))).not.toHaveLength(0);
    }
    expect(nodesWithTestID(tree, moteID(DUST_COUNT))).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('crosses the two arms so the glyph reads as a sparkle rather than a single lozenge', () => {
    // Each arm is long one way and narrow the other. If both were stretched along the same axis
    // they would stack into one lozenge and the four-armed silhouette would be lost.
    const tree = render(<SparkleGlyph color="#fff" />);

    const upright = styleOf(tree, 'sparkle-glyph-arm-upright');
    const across = styleOf(tree, 'sparkle-glyph-arm-across');

    expect(numberIn(upright, 'scaleY')).toBeGreaterThan(numberIn(upright, 'scaleX'));
    expect(numberIn(across, 'scaleX')).toBeGreaterThan(numberIn(across, 'scaleY'));
    // The arms are the same shape, just swapped, so the sparkle stays symmetric as it turns.
    expect(numberIn(upright, 'scaleY')).toBeCloseTo(numberIn(across, 'scaleX'), 5);
    expect(numberIn(upright, 'scaleX')).toBeCloseTo(numberIn(across, 'scaleY'), 5);
    // A long arm on a narrow waist is what makes the notches concave; a fat waist reads as a plus.
    expect(armWaist(upright)).toBeLessThan(armTip(upright) / 2);
    // Both arms share the same rotation, so they stay square to each other.
    expect(turnOf(upright)).toBeCloseTo(turnOf(across), 5);

    act(() => tree.unmount());
  });

  it('returns to its starting frame at the end of the loop so the animation does not jump', () => {
    // The mock resolves animations to their target immediately, so a running loop settles on the
    // final frame. That frame has to match the first one or the glyph visibly snaps every cycle.
    const tree = render(<SparkleGlyph color="#fff" />);
    const [phase] = mockSharedValues;
    expect(phase?.value).toBe(1);

    // A four-armed sparkle maps onto itself every quarter turn, so a half turn is the same
    // silhouette it started with.
    const upright = styleOf(tree, 'sparkle-glyph-arm-upright');
    expect(turnOf(upright)).toBeCloseTo(Math.PI, 5);
    // ...and it is back to its resting size, not caught mid-flare.
    expect(armTip(upright)).toBeCloseTo(ARM_MIN, 5);
    expect(armWaist(upright)).toBeCloseTo(WAIST_MIN, 5);

    // Each mote is back at the start of its own life: at the inner orbit and not yet faded in.
    const first = styleOf(tree, moteID(0));
    expect(Math.hypot(numberIn(first, 'translateX'), numberIn(first, 'translateY'))).toBeCloseTo(
      DUST_ORBIT_START,
      5,
    );
    expect(first['opacity']).toBeCloseTo(0, 5);

    act(() => tree.unmount());
  });

  it('spreads the dust around the sparkle instead of bunching it on one side', () => {
    // The motes share one clock, so a mistake in the per-mote offset collapses them into a single
    // travelling dot and the glyph loses the sense of something being shaken loose.
    const tree = render(<SparkleGlyph color="#fff" />);

    const angles = Array.from({ length: DUST_COUNT }, (_, index) => {
      const style = styleOf(tree, moteID(index));
      const angle = Math.atan2(numberIn(style, 'translateY'), numberIn(style, 'translateX'));
      return angle < 0 ? angle + Math.PI * 2 : angle;
    }).sort((left, right) => left - right);
    // No mote may be more than a fifth of a turn ahead of the one behind it, wrapping around. A
    // clustered ring reads as one travelling clump rather than as dust shed all around the sparkle.
    const gaps = angles.map((angle, index) =>
      index === 0
        ? (angles[0] ?? 0) + Math.PI * 2 - (angles[DUST_COUNT - 1] ?? 0)
        : angle - (angles[index - 1] ?? 0),
    );
    expect(Math.max(...gaps)).toBeLessThan((Math.PI * 2) / DUST_COUNT + 0.5);

    // Motes at different points in their life sit at different distances, which is what makes the
    // dust read as drifting outward rather than as a fixed ring.
    const orbits = Array.from({ length: DUST_COUNT }, (_, index) => {
      const style = styleOf(tree, moteID(index));
      return Math.hypot(numberIn(style, 'translateX'), numberIn(style, 'translateY'));
    });
    expect(Math.max(...orbits) - Math.min(...orbits)).toBeGreaterThan(2);

    act(() => tree.unmount());
  });

  it('fades every mote in as it separates and out as it drifts away', () => {
    const tree = render(<SparkleGlyph color="#fff" />);

    for (let index = 0; index < DUST_COUNT; index += 1) {
      const opacity = styleOf(tree, moteID(index))['opacity'] as number;
      expect(opacity).toBeGreaterThanOrEqual(0);
      expect(opacity).toBeLessThanOrEqual(1);
    }
    // The youngest mote is still invisible, so dust never pops into existence.
    expect(styleOf(tree, moteID(0))['opacity']).toBeCloseTo(0, 5);

    act(() => tree.unmount());
  });

  it('draws the whole glyph in the caller tone so it never introduces its own colour', () => {
    // The glyph inherits the status row's tone. A stray second colour would make the row look like
    // it means something it does not.
    const tree = render(<SparkleGlyph color="#ff0000" />);

    for (const id of ['sparkle-glyph-arm-upright', 'sparkle-glyph-arm-across']) {
      expect(styleOf(tree, id)['backgroundColor']).toBe('#ff0000');
    }
    for (let index = 0; index < DUST_COUNT; index += 1) {
      expect(styleOf(tree, moteID(index))['backgroundColor']).toBe('#ff0000');
    }

    act(() => tree.unmount());
  });

  it('loops continuously and stops the loop on unmount', () => {
    const cancelSpy = jest.spyOn(reanimatedMock, 'cancelAnimation').mockImplementation(() => {});

    const tree = render(<SparkleGlyph color="#fff" />);
    const [phase] = mockSharedValues;
    expect(phase?.value).toBe(1);

    act(() => tree.unmount());
    expect(cancelSpy).toHaveBeenCalledWith(phase);
    cancelSpy.mockRestore();
  });

  it('holds the sparkle open at full size while Reduce Motion is enabled', () => {
    setMockReducedMotionEnabled(true);
    const tree = render(<SparkleGlyph color="#fff" />);

    const [phase] = mockSharedValues;
    // Parked on the chosen static frame, not advanced: a running loop would have settled at 1.
    expect(phase?.value).toBe(STATIC_PHASE);
    // That frame is the flare at its peak, so the resting glyph is the fullest sparkle rather than
    // the smallest one.
    const upright = styleOf(tree, 'sparkle-glyph-arm-upright');
    expect(armTip(upright)).toBeCloseTo(ARM_MAX, 5);
    // A quarter turn leaves a four-armed sparkle square to the row, so it looks deliberate at rest.
    expect(turnOf(upright)).toBeCloseTo(Math.PI / 2, 5);

    act(() => tree.unmount());
  });

  it('flares as it turns rather than holding one size', () => {
    // Without the flare the glyph is a rigid pinwheel; the swell is what makes it feel alive.
    const running = render(<SparkleGlyph color="#fff" />);
    const restingTip = armTip(styleOf(running, 'sparkle-glyph-arm-upright'));
    act(() => running.unmount());

    resetMockSharedValues();
    setMockReducedMotionEnabled(true);
    const parked = render(<SparkleGlyph color="#fff" />);
    expect(armTip(styleOf(parked, 'sparkle-glyph-arm-upright'))).toBeGreaterThan(restingTip);

    act(() => parked.unmount());
  });

  it('keeps the sparkle and its dust inside the row-sized box', () => {
    // The glyph shares a short status row, so nothing may spill past the box and collide with the
    // caption next to it.
    const tree = render(<SparkleGlyph color="#fff" testID="sparkle-glyph" />);
    const box = styleOf(tree, 'sparkle-glyph');
    expect(box['width']).toBe(BOX);
    expect(box['height']).toBe(BOX);
    const half = BOX / 2;

    for (const id of ['sparkle-glyph-arm-upright', 'sparkle-glyph-arm-across']) {
      expect(armTip(styleOf(tree, id))).toBeLessThanOrEqual(half);
    }
    // The flare is the widest moment of the loop, so check it too rather than only the resting frame.
    expect(ARM_MAX).toBeLessThanOrEqual(half);

    for (let index = 0; index < DUST_COUNT; index += 1) {
      const mote = styleOf(tree, moteID(index));
      const radius = ((mote['height'] as number) / 2) * numberIn(mote, 'scale');
      const distance = Math.hypot(numberIn(mote, 'translateX'), numberIn(mote, 'translateY'));
      expect(distance + radius).toBeLessThanOrEqual(half);
    }

    act(() => tree.unmount());
  });

  it('hides itself from screen readers because it carries no information', () => {
    const tree = render(<SparkleGlyph color="#fff" />);
    const [root] = nodesWithTestID(tree, 'sparkle-glyph');

    expect(root?.props['accessibilityElementsHidden']).toBe(true);

    act(() => tree.unmount());
  });
});
