import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AtomGlyph } from './AtomGlyph';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

import * as reanimatedMock from '@shared/testing/reanimatedMock';

const {
  mockFrameCallbacks,
  mockSharedValues,
  resetMockFrameCallbacks,
  resetMockSharedValues,
  setMockReducedMotionEnabled,
} = reanimatedMock;

/** Shells and the particles on each, mirroring the component. */
const SHELL_COUNT = 3;
const PARTICLES_PER_SHELL = 2;
const PARTICLE_COUNT = SHELL_COUNT * PARTICLES_PER_SHELL;
const LOOP_DURATION_MS = 2600;
/** Rectangles whose union is the core, mirroring `BLADE_COUNT` in the component. */
const BLADE_COUNT = 3;
const BOX = 20;
const HALF = BOX / 2;
const TAU = Math.PI * 2;

type Props = Record<string, unknown>;

type Queryable = ReactTestInstance & {
  props: Props;
  findAll(predicate: (node: Queryable) => boolean, options?: { deep: boolean }): Queryable[];
};

interface Harness {
  tree: ReactTestRenderer;
  /** Moves the animation clock and re-renders, so assertions can walk the whole loop. */
  setPhase(value: number): void;
}

function render(node: React.ReactElement): Harness {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(node);
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  const rendered = tree;
  // The mock evaluates `useAnimatedStyle` once, during render, which happens before the effect
  // starts the clock. Re-rendering picks up the phase the effect actually left behind, so these
  // assertions describe the animating glyph rather than its untouched first frame. A bare
  // `update(node)` is not enough: React bails out when handed a referentially identical element.
  const refresh = () => {
    act(() => {
      rendered.update(React.cloneElement(node));
    });
  };
  refresh();
  return {
    tree: rendered,
    setPhase(value) {
      const [phase] = mockSharedValues;
      if (!phase) {
        throw new Error('Component created no shared value');
      }
      phase.value = value * LOOP_DURATION_MS;
      refresh();
    },
  };
}

function nodesWithTestID(tree: ReactTestRenderer, testID: string): Queryable[] {
  return (tree.root as Queryable).findAll((node) => node.props['testID'] === testID, {
    deep: true,
  });
}

function styleOf(tree: ReactTestRenderer, testID: string): Props {
  // `testID` is also a prop of the `AtomGlyph` element itself, so skip the composite node and take
  // the host view that actually carries the style.
  const [style] = nodesWithTestID(tree, testID)
    .map((node) => StyleSheet.flatten(node.props['style'] as never) as Props | undefined)
    .filter((flattened): flattened is Props => Boolean(flattened));
  if (!style) {
    throw new Error(`No styled node found for testID ${testID}`);
  }
  return style;
}

function numberIn(style: Props, key: string): number {
  const transform = (style['transform'] ?? []) as Record<string, number | string>[];
  const entry = transform.find((item) => item[key] !== undefined);
  return (entry?.[key] as number | undefined) ?? 0;
}

const particleID = (index: number) => `atom-glyph-particle-${String(index)}`;

interface Placement {
  x: number;
  y: number;
  /** Radius on screen, after the depth cue has grown or shrunk the particle. */
  radius: number;
  scale: number;
}

function placementsOf(tree: ReactTestRenderer): Placement[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, index) => {
    const style = styleOf(tree, particleID(index));
    const scale = numberIn(style, 'scale');
    return {
      x: numberIn(style, 'translateX'),
      y: numberIn(style, 'translateY'),
      radius: ((style['height'] as number) / 2) * scale,
      scale,
    };
  });
}

/** How far apart the two particles of a shell sit, which is what collapses as the shell tips. */
function shellSpans(tree: ReactTestRenderer): number[] {
  const points = placementsOf(tree);
  return Array.from({ length: SHELL_COUNT }, (_, shell) => {
    const a = points[shell * PARTICLES_PER_SHELL];
    const b = points[shell * PARTICLES_PER_SHELL + 1];
    return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
  });
}

interface Blade {
  /** Corner radius and half-extents as rendered, so box checks never trust a mirrored constant. */
  radius: number;
  halfWidth: number;
  halfHeight: number;
  rotation: number;
  /** Furthest point of the rounded rectangle from the glyph's centre. */
  reach: number;
}

function bladeOf(tree: ReactTestRenderer, index: number): Blade {
  const style = styleOf(tree, `atom-glyph-blade-${String(index)}`);
  const transform = (style['transform'] ?? []) as Record<string, number | string>[];
  const turn = transform.find((item) => typeof item['rotate'] === 'string');
  const scaled = transform.find((item) => item['scale'] !== undefined);
  const scale = (scaled?.['scale'] as number | undefined) ?? 1;

  const radius = (style['borderRadius'] as number) * scale;
  const halfWidth = ((style['width'] as number) / 2) * scale;
  const halfHeight = ((style['height'] as number) / 2) * scale;
  return {
    radius,
    halfWidth,
    halfHeight,
    rotation: Number.parseFloat(String(turn?.['rotate'] ?? '0')),
    reach: Math.hypot(halfWidth - radius, halfHeight - radius) + radius,
  };
}

function bladesOf(tree: ReactTestRenderer): Blade[] {
  return Array.from({ length: BLADE_COUNT }, (_, index) => bladeOf(tree, index));
}

describe('AtomGlyph', () => {
  beforeEach(() => {
    resetMockFrameCallbacks();
    resetMockSharedValues();
    setMockReducedMotionEnabled(false);
  });

  afterEach(() => {
    setMockReducedMotionEnabled(false);
  });

  it('draws a core with two particles on each shell', () => {
    const { tree } = render(<AtomGlyph color="#fff" />);

    for (let index = 0; index < BLADE_COUNT; index += 1) {
      expect(nodesWithTestID(tree, `atom-glyph-blade-${String(index)}`)).not.toHaveLength(0);
    }
    expect(nodesWithTestID(tree, `atom-glyph-blade-${String(BLADE_COUNT)}`)).toHaveLength(0);
    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      expect(nodesWithTestID(tree, particleID(index))).not.toHaveLength(0);
    }
    expect(nodesWithTestID(tree, particleID(PARTICLE_COUNT))).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('sets each shell on its own tilt so they do not stack into a single ring', () => {
    // Three shells drawn at the same tilt would overlap exactly and the glyph would lose its
    // three-dimensional read, collapsing into two fat dots.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);
    setPhase(0);

    const axes = Array.from({ length: SHELL_COUNT }, (_, shell) => {
      const point = placementsOf(tree)[shell * PARTICLES_PER_SHELL];
      return Math.atan2(point?.y ?? 0, point?.x ?? 0);
    });
    for (let shell = 0; shell < SHELL_COUNT; shell += 1) {
      for (let other = shell + 1; other < SHELL_COUNT; other += 1) {
        const gap = Math.abs((axes[shell] ?? 0) - (axes[other] ?? 0)) % Math.PI;
        expect(Math.min(gap, Math.PI - gap)).toBeGreaterThan(0.5);
      }
    }

    act(() => tree.unmount());
  });

  it('tips the shells on their own schedules so they are never all face on together', () => {
    // Shells sharing one schedule would breathe in unison and the atom would read as a single flat
    // ring opening and closing rather than as a body with things going round it in three planes.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);
    setPhase(0.125);

    const spans = shellSpans(tree);
    expect(Math.max(...spans) - Math.min(...spans)).toBeGreaterThan(2);
    // The narrowest shell is nearly edge on, which is what sells the tipping.
    expect(Math.min(...spans)).toBeLessThan(Math.max(...spans) / 3);

    act(() => tree.unmount());
  });

  it('grows the near particles and shrinks the far ones so the shells read as depth', () => {
    // Everything is one flat tone, so size is the only cue that says one particle is in front of
    // the core and another is behind it.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);
    setPhase(0.125);

    const scales = placementsOf(tree).map((point) => point.scale);
    expect(Math.max(...scales)).toBeGreaterThan(1.1);
    expect(Math.min(...scales)).toBeLessThan(0.9);

    act(() => tree.unmount());
  });

  it('carries the particles right round the core rather than rocking them back and forth', () => {
    // An eighth of the way through the loop every particle has moved a long way, which only happens
    // if they are travelling a full circuit instead of oscillating.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);

    setPhase(0);
    const start = placementsOf(tree);
    setPhase(0.125);
    const later = placementsOf(tree);

    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      const from = start[index];
      const to = later[index];
      expect(
        Math.hypot((from?.x ?? 0) - (to?.x ?? 0), (from?.y ?? 0) - (to?.y ?? 0)),
      ).toBeGreaterThan(3);
    }

    act(() => tree.unmount());
  });

  it('builds the core out of three rectangles evenly turned so their union is a hexagon', () => {
    // A regular hexagon is the union of three congruent rectangles a sixth of a turn apart, each
    // one sqrt(3) times as wide as it is tall. Break either the proportion or the spacing and the
    // union stops being a hexagon.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);
    setPhase(0.5);

    const blades = bladesOf(tree);
    for (const blade of blades) {
      expect(blade.halfWidth / blade.halfHeight).toBeCloseTo(Math.sqrt(3), 5);
    }
    for (let index = 1; index < BLADE_COUNT; index += 1) {
      const step = (blades[index]?.rotation ?? 0) - (blades[index - 1]?.rotation ?? 0);
      expect(step).toBeCloseTo(Math.PI / BLADE_COUNT, 6);
    }
    // Every rectangle is the same size, so no corner of the hexagon sticks out further than another.
    expect(Math.max(...blades.map((blade) => blade.reach))).toBeCloseTo(
      Math.min(...blades.map((blade) => blade.reach)),
      6,
    );

    act(() => tree.unmount());
  });

  it('melts the core between a crisp hexagon and a circle', () => {
    // A core that merely sat there would make the glyph read as a spinner with a dot in it. The
    // shape change is the point: it has to actually reach both states.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);

    setPhase(0.5);
    const [hexagon] = bladesOf(tree);
    // Barely rounded, so the hexagon's corners are sharp enough to be read as corners.
    expect(hexagon?.radius ?? 0).toBeLessThan((hexagon?.halfHeight ?? 0) / 4);

    setPhase(0);
    const [circle] = bladesOf(tree);
    // Fully rounded: each rectangle is a capsule, and three capsules union into a near-circle.
    expect(circle?.radius ?? 0).toBeCloseTo(circle?.halfHeight ?? Number.NaN, 5);
    // Rounding costs area, so the circle is grown a little to keep the core's mass steady.
    expect(circle?.halfHeight ?? 0).toBeGreaterThan(hexagon?.halfHeight ?? 0);

    act(() => tree.unmount());
  });

  it('dwells longer on the hexagon than on the circle', () => {
    // A circle is what any small shape degrades into when it blurs, so the hexagon is the state
    // worth holding. Without a bias the morph splits its time evenly and reads as a pulsing blob.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);

    const samples = 240;
    let hexagonFrames = 0;
    let circleFrames = 0;
    for (let step = 0; step < samples; step += 1) {
      setPhase(step / samples);
      const [blade] = bladesOf(tree);
      const roundness = (blade?.radius ?? 0) / (blade?.halfHeight ?? 1);
      if (roundness < 0.25) {
        hexagonFrames += 1;
      }
      if (roundness > 0.75) {
        circleFrames += 1;
      }
    }

    expect(hexagonFrames).toBeGreaterThan(circleFrames);

    act(() => tree.unmount());
  });

  it('turns the core as it morphs so the hexagon never sits still', () => {
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);

    setPhase(0);
    const from = bladeOf(tree, 0).rotation;
    setPhase(0.5);
    expect(bladeOf(tree, 0).rotation - from).toBeGreaterThan(0.1);

    act(() => tree.unmount());
  });

  it('returns to its starting frame at the end of the loop so the animation does not jump', () => {
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);

    setPhase(1);
    const end = placementsOf(tree);
    const endCore = bladeOf(tree, 0);
    setPhase(0);
    const start = placementsOf(tree);
    const startCore = bladeOf(tree, 0);

    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      expect(end[index]?.x).toBeCloseTo(start[index]?.x ?? Number.NaN, 5);
      expect(end[index]?.y).toBeCloseTo(start[index]?.y ?? Number.NaN, 5);
      expect(end[index]?.scale).toBeCloseTo(start[index]?.scale ?? Number.NaN, 5);
    }
    expect(endCore.radius).toBeCloseTo(startCore.radius, 5);
    expect(endCore.halfHeight).toBeCloseTo(startCore.halfHeight, 5);
    // A whole number of sixth-turns, so the hexagon lands back on the silhouette it started from.
    const sixth = TAU / 6;
    expect((endCore.rotation - startCore.rotation) / sixth).toBeCloseTo(
      Math.round((endCore.rotation - startCore.rotation) / sixth),
      5,
    );

    act(() => tree.unmount());
  });

  it('draws the whole glyph in the caller tone so it never introduces its own colour', () => {
    // The glyph inherits the status row's tone. A stray second colour would make the row look like
    // it means something it does not.
    const { tree } = render(<AtomGlyph color="#ff0000" />);

    for (let index = 0; index < BLADE_COUNT; index += 1) {
      expect(styleOf(tree, `atom-glyph-blade-${String(index)}`)['backgroundColor']).toBe('#ff0000');
    }
    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      expect(styleOf(tree, particleID(index))['backgroundColor']).toBe('#ff0000');
    }

    act(() => tree.unmount());
  });

  it('uses the screen clock instead of creating an independent frame callback', () => {
    const { tree } = render(<AtomGlyph color="#fff" />);
    expect(mockFrameCallbacks).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('holds a settled frame while Reduce Motion is enabled', () => {
    setMockReducedMotionEnabled(true);
    const { tree } = render(<AtomGlyph color="#fff" />);

    // The resting core is the crisp hexagon, which looks deliberate in a way a half-melted one
    // would not.
    const [blade] = bladesOf(tree);
    expect(blade?.radius ?? 0).toBeLessThan((blade?.halfHeight ?? 0) / 4);
    // Every particle fully extended and evenly spaced, one to each corner of the hexagon.
    const points = placementsOf(tree);
    const orbits = points.map((point) => Math.hypot(point.x, point.y));
    expect(Math.max(...orbits) - Math.min(...orbits)).toBeLessThan(0.001);
    const angles = points
      .map((point) => {
        const angle = Math.atan2(point.y, point.x);
        return angle < 0 ? angle + TAU : angle;
      })
      .sort((left, right) => left - right);
    for (let index = 1; index < angles.length; index += 1) {
      expect((angles[index] ?? 0) - (angles[index - 1] ?? 0)).toBeCloseTo(TAU / PARTICLE_COUNT, 5);
    }

    act(() => tree.unmount());
  });

  it('keeps the core and every particle inside the row-sized box at all times', () => {
    // The glyph shares a short status row, so nothing may spill past the box and collide with the
    // caption next to it. Peak frames hide between samples, so walk the whole loop rather than
    // trusting the resting frame.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" testID="atom-glyph" />);
    const box = styleOf(tree, 'atom-glyph');
    expect(box['width']).toBe(BOX);
    expect(box['height']).toBe(BOX);

    const steps = 240;
    for (let step = 0; step <= steps; step += 1) {
      setPhase(step / steps);

      // The core turns, so its corners are what reach furthest.
      for (const blade of bladesOf(tree)) {
        expect(blade.reach).toBeLessThanOrEqual(HALF);
      }

      for (const point of placementsOf(tree)) {
        expect(Math.hypot(point.x, point.y) + point.radius).toBeLessThanOrEqual(HALF);
      }
    }

    act(() => tree.unmount());
  });

  it('keeps the particles clear of the core so the two never smear into one lump', () => {
    // At 20px the near particles grow enough to touch a core sitting too close, and the silhouette
    // stops reading as a nucleus with electrons around it and starts reading as a blob.
    const { tree, setPhase } = render(<AtomGlyph color="#fff" />);

    let orbit = 0;
    let widestParticle = 0;
    let widestCore = 0;

    const steps = 240;
    for (let step = 0; step <= steps; step += 1) {
      setPhase(step / steps);

      widestCore = Math.max(widestCore, ...bladesOf(tree).map((blade) => blade.reach));
      for (const point of placementsOf(tree)) {
        orbit = Math.max(orbit, Math.hypot(point.x, point.y));
        widestParticle = Math.max(widestParticle, point.radius);
      }
    }

    // Worst case: the largest a particle ever gets, sat where the orbit carries it furthest out.
    expect(orbit - widestParticle).toBeGreaterThan(widestCore);

    act(() => tree.unmount());
  });

  it('hides itself from screen readers because it carries no information', () => {
    const { tree } = render(<AtomGlyph color="#fff" />);
    const [root] = nodesWithTestID(tree, 'atom-glyph');

    expect(root?.props['accessibilityElementsHidden']).toBe(true);

    act(() => tree.unmount());
  });
});
