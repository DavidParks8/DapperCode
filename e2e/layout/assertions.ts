import { expect, type Locator } from '@playwright/test';

import {
  contains,
  describeRect,
  horizontalGap,
  overlapArea,
  readGeometry,
  readRect,
  readRects,
  readViewportRect,
  verticalGap,
  type Rect,
} from './geometry.ts';

/** Sub-pixel rounding in the browser makes exact equality unusable for layout comparisons. */
export const DEFAULT_TOLERANCE = 1;

/** Apple and Material both put the minimum comfortable touch target at 44 points. */
export const MIN_TOUCH_TARGET = 44;

export interface LayoutAssertionOptions {
  /** Allowed deviation in CSS pixels. */
  readonly tolerance?: number;
  /** How long to keep re-measuring while layout settles. */
  readonly timeout?: number;
  /** Extra context included in the failure message. */
  readonly message?: string;
}

/**
 * A set of elements to compare, given either explicitly or as one locator that matches many.
 *
 * Accepting both matters in practice: rows rendered by a list are naturally addressed by a single
 * `[data-testid^="..."]` locator, while hand-picked surfaces are naturally an array.
 */
export type LocatorGroup = readonly Locator[] | Locator;

async function readGroupRects(group: LocatorGroup): Promise<Rect[]> {
  if (Array.isArray(group)) {
    return Promise.all(group.map((target) => readRect(target)));
  }
  return readRects(group as Locator);
}

function requireGroupSize(rects: readonly Rect[], what: string): void {
  if (rects.length < 2) {
    fail(`${what} needs at least two elements, measured ${String(rects.length)}.`);
  }
}

const DEFAULT_TIMEOUT = 5_000;
const POLL_INTERVAL = 100;

/**
 * Re-measures until the assertion holds or the timeout elapses.
 *
 * Layout assertions race against transitions, image loading, and list virtualization, so a single
 * measurement is inherently flaky. Retrying keeps the assertions honest without weakening them:
 * the final failure still reports the last real measurement.
 */
async function pollLayout(
  assertion: () => Promise<void>,
  options: LayoutAssertionOptions | undefined,
): Promise<void> {
  const deadline = Date.now() + (options?.timeout ?? DEFAULT_TIMEOUT);
  let lastError: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }
  throw decorate(lastError, options?.message);
}

function decorate(error: unknown, message: string | undefined): unknown {
  if (!message || !(error instanceof Error)) {
    return error;
  }
  error.message = `${message}\n${error.message}`;
  return error;
}

function fail(message: string): never {
  throw new Error(message);
}

function within(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

/** Asserts the element is laid out with a real, non-zero size and is not hidden by styles. */
export async function expectVisible(
  target: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  await pollLayout(async () => {
    const geometry = await readGeometry(target);
    if (!geometry.visible) {
      fail(`Expected element to be visibly laid out, but measured ${describeRect(geometry.rect)}.`);
    }
  }, options);
}

/** Asserts every element shares the same left edge, which is the usual sign of a shared rail. */
export async function expectLeftAligned(
  targets: LocatorGroup,
  options?: LayoutAssertionOptions,
): Promise<void> {
  await expectEdgeAligned(targets, 'left', options);
}

export async function expectRightAligned(
  targets: LocatorGroup,
  options?: LayoutAssertionOptions,
): Promise<void> {
  await expectEdgeAligned(targets, 'right', options);
}

export async function expectTopAligned(
  targets: LocatorGroup,
  options?: LayoutAssertionOptions,
): Promise<void> {
  await expectEdgeAligned(targets, 'top', options);
}

export async function expectBottomAligned(
  targets: LocatorGroup,
  options?: LayoutAssertionOptions,
): Promise<void> {
  await expectEdgeAligned(targets, 'bottom', options);
}

async function expectEdgeAligned(
  targets: LocatorGroup,
  edge: 'left' | 'right' | 'top' | 'bottom',
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const rects = await readGroupRects(targets);
    requireGroupSize(rects, 'Alignment');
    const [first, ...rest] = rects as [Rect, ...Rect[]];
    const baseline = first[edge];
    const offender = rest.findIndex((rect) => !within(rect[edge], baseline, tolerance));
    if (offender >= 0) {
      const actual = rest[offender] as Rect;
      fail(
        `Expected all elements to share a ${edge} edge within ${String(tolerance)}px.\n` +
          `  element[0]: ${describeRect(first)}\n` +
          `  element[${String(offender + 1)}]: ${describeRect(actual)}\n` +
          `  ${edge} delta: ${String(Math.round((actual[edge] - baseline) * 100) / 100)}px`,
      );
    }
  }, options);
}

/** Asserts the child is horizontally centered inside the container. */
export async function expectHorizontallyCentered(
  child: Locator,
  container: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const [childRect, containerRect] = await Promise.all([readRect(child), readRect(container)]);
    if (!within(childRect.centerX, containerRect.centerX, tolerance)) {
      const leftInset = childRect.left - containerRect.left;
      const rightInset = containerRect.right - childRect.right;
      fail(
        `Expected the child to be horizontally centered within ${String(tolerance)}px.\n` +
          `  child:     ${describeRect(childRect)}\n` +
          `  container: ${describeRect(containerRect)}\n` +
          `  left inset ${String(Math.round(leftInset * 100) / 100)}px vs right inset ${String(
            Math.round(rightInset * 100) / 100,
          )}px`,
      );
    }
  }, options);
}

/** Asserts the child has matching left and right insets inside the container. */
export async function expectSymmetricHorizontalInsets(
  child: Locator,
  container: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const [childRect, containerRect] = await Promise.all([readRect(child), readRect(container)]);
    const leftInset = childRect.left - containerRect.left;
    const rightInset = containerRect.right - childRect.right;
    if (!within(leftInset, rightInset, tolerance)) {
      fail(
        `Expected symmetric horizontal insets within ${String(tolerance)}px, ` +
          `but measured left ${String(Math.round(leftInset * 100) / 100)}px and right ${String(
            Math.round(rightInset * 100) / 100,
          )}px.\n` +
          `  child:     ${describeRect(childRect)}\n` +
          `  container: ${describeRect(containerRect)}`,
      );
    }
  }, options);
}

/** Asserts the vertical gap between two stacked elements equals an expected value. */
export async function expectVerticalGap(
  above: Locator,
  below: Locator,
  expected: number,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const [aboveRect, belowRect] = await Promise.all([readRect(above), readRect(below)]);
    const gap = verticalGap(aboveRect, belowRect);
    if (!within(gap, expected, tolerance)) {
      fail(
        `Expected a vertical gap of ${String(expected)}px (±${String(tolerance)}), measured ${String(
          Math.round(gap * 100) / 100,
        )}px.\n` +
          `  above: ${describeRect(aboveRect)}\n` +
          `  below: ${describeRect(belowRect)}`,
      );
    }
  }, options);
}

export async function expectVerticalGapWithin(
  above: Locator,
  below: Locator,
  range: { min: number; max: number },
  options?: LayoutAssertionOptions,
): Promise<void> {
  await pollLayout(async () => {
    const [aboveRect, belowRect] = await Promise.all([readRect(above), readRect(below)]);
    const gap = verticalGap(aboveRect, belowRect);
    if (gap < range.min || gap > range.max) {
      fail(
        `Expected a vertical gap between ${String(range.min)}px and ${String(
          range.max,
        )}px, measured ${String(Math.round(gap * 100) / 100)}px.\n` +
          `  above: ${describeRect(aboveRect)}\n` +
          `  below: ${describeRect(belowRect)}`,
      );
    }
  }, options);
}

export async function expectHorizontalGap(
  leading: Locator,
  trailing: Locator,
  expected: number,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const [leadingRect, trailingRect] = await Promise.all([readRect(leading), readRect(trailing)]);
    const gap = horizontalGap(leadingRect, trailingRect);
    if (!within(gap, expected, tolerance)) {
      fail(
        `Expected a horizontal gap of ${String(expected)}px (±${String(
          tolerance,
        )}), measured ${String(Math.round(gap * 100) / 100)}px.\n` +
          `  leading:  ${describeRect(leadingRect)}\n` +
          `  trailing: ${describeRect(trailingRect)}`,
      );
    }
  }, options);
}

/** Asserts two elements do not visually collide. */
export async function expectNoOverlap(
  first: Locator,
  second: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  await pollLayout(async () => {
    const [firstRect, secondRect] = await Promise.all([readRect(first), readRect(second)]);
    const area = overlapArea(firstRect, secondRect);
    if (area > 0) {
      fail(
        `Expected the elements not to overlap, but they share ${String(
          Math.round(area),
        )}px² of area.\n` +
          `  first:  ${describeRect(firstRect)}\n` +
          `  second: ${describeRect(secondRect)}`,
      );
    }
  }, options);
}

export async function expectOverlaps(
  first: Locator,
  second: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  await pollLayout(async () => {
    const [firstRect, secondRect] = await Promise.all([readRect(first), readRect(second)]);
    if (overlapArea(firstRect, secondRect) <= 0) {
      fail(
        `Expected the elements to overlap, but they are disjoint.\n` +
          `  first:  ${describeRect(firstRect)}\n` +
          `  second: ${describeRect(secondRect)}`,
      );
    }
  }, options);
}

/**
 * Asserts elements are stacked top to bottom in the given order and never overlap.
 *
 * This is the assertion that catches reordered rows and collapsed spacing at the same time.
 */
export async function expectStackedVertically(
  targets: LocatorGroup,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const rects = await readGroupRects(targets);
    requireGroupSize(rects, 'Stacking');
    for (let index = 1; index < rects.length; index += 1) {
      const previous = rects[index - 1] as Rect;
      const current = rects[index] as Rect;
      if (current.top < previous.bottom - tolerance) {
        fail(
          `Expected element ${String(index)} to sit below element ${String(index - 1)}.\n` +
            `  element[${String(index - 1)}]: ${describeRect(previous)}\n` +
            `  element[${String(index)}]: ${describeRect(current)}\n` +
            `  overlap: ${String(Math.round((previous.bottom - current.top) * 100) / 100)}px`,
        );
      }
    }
  }, options);
}

/** Asserts elements are laid out left to right in the given order and never overlap. */
export async function expectRowOrder(
  targets: LocatorGroup,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const rects = await readGroupRects(targets);
    requireGroupSize(rects, 'Row order');
    for (let index = 1; index < rects.length; index += 1) {
      const previous = rects[index - 1] as Rect;
      const current = rects[index] as Rect;
      if (current.left < previous.right - tolerance) {
        fail(
          `Expected element ${String(index)} to sit to the right of element ${String(index - 1)}.\n` +
            `  element[${String(index - 1)}]: ${describeRect(previous)}\n` +
            `  element[${String(index)}]: ${describeRect(current)}`,
        );
      }
    }
  }, options);
}

/** Asserts the child is fully inside the container's box. */
export async function expectContainedWithin(
  child: Locator,
  container: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const [childRect, containerRect] = await Promise.all([readRect(child), readRect(container)]);
    if (!contains(containerRect, childRect, tolerance)) {
      fail(
        `Expected the child to be fully contained by the container.\n` +
          `  child:     ${describeRect(childRect)}\n` +
          `  container: ${describeRect(containerRect)}\n` +
          `  overflow: left ${String(
            Math.round((containerRect.left - childRect.left) * 100) / 100,
          )}px, top ${String(
            Math.round((containerRect.top - childRect.top) * 100) / 100,
          )}px, right ${String(
            Math.round((childRect.right - containerRect.right) * 100) / 100,
          )}px, bottom ${String(
            Math.round((childRect.bottom - containerRect.bottom) * 100) / 100,
          )}px`,
      );
    }
  }, options);
}

/** Asserts the element is fully on screen. */
export async function expectWithinViewport(
  target: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const rect = await readRect(target);
    const viewport = await readViewportRect(target.page());
    if (!contains(viewport, rect, tolerance)) {
      fail(
        `Expected the element to be fully inside the viewport.\n` +
          `  element:  ${describeRect(rect)}\n` +
          `  viewport: ${describeRect(viewport)}`,
      );
    }
  }, options);
}

/** Asserts the element is not cut off by its nearest clipping ancestor. */
export async function expectNotClipped(
  target: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const geometry = await readGeometry(target);
    const clip = geometry.overflowHiddenAncestor;
    if (clip && !contains(clip, geometry.rect, tolerance)) {
      fail(
        `Expected the element not to be clipped by its scrolling or masked ancestor.\n` +
          `  element:  ${describeRect(geometry.rect)}\n` +
          `  clip box: ${describeRect(clip)}`,
      );
    }
  }, options);
}

/** Asserts the element meets the minimum comfortable touch target size. */
export async function expectTouchTarget(
  target: Locator,
  minimum = MIN_TOUCH_TARGET,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const rect = await readRect(target);
    if (rect.width < minimum - tolerance || rect.height < minimum - tolerance) {
      fail(
        `Expected a touch target of at least ${String(minimum)}×${String(
          minimum,
        )}px, measured ${String(Math.round(rect.width * 100) / 100)}×${String(
          Math.round(rect.height * 100) / 100,
        )}px.\n  element: ${describeRect(rect)}`,
      );
    }
  }, options);
}

/** Asserts two elements render at the same size, which keeps paired controls visually balanced. */
export async function expectSameSize(
  first: Locator,
  second: Locator,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  await pollLayout(async () => {
    const [firstRect, secondRect] = await Promise.all([readRect(first), readRect(second)]);
    const sameWidth = within(firstRect.width, secondRect.width, tolerance);
    const sameHeight = within(firstRect.height, secondRect.height, tolerance);
    if (!sameWidth || !sameHeight) {
      fail(
        `Expected both elements to render at the same size within ${String(tolerance)}px.\n` +
          `  first:  ${describeRect(firstRect)}\n` +
          `  second: ${describeRect(secondRect)}`,
      );
    }
  }, options);
}

/** Asserts an element keeps a stable box across an interaction, catching layout jumps. */
export async function expectStableLayout(
  target: Locator,
  action: () => Promise<void>,
  options?: LayoutAssertionOptions,
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  const before = await readRect(target);
  await action();
  await pollLayout(async () => {
    const after = await readRect(target);
    const moved =
      !within(after.left, before.left, tolerance) ||
      !within(after.top, before.top, tolerance) ||
      !within(after.width, before.width, tolerance) ||
      !within(after.height, before.height, tolerance);
    if (moved) {
      fail(
        `Expected the element's layout to stay stable across the interaction.\n` +
          `  before: ${describeRect(before)}\n` +
          `  after:  ${describeRect(after)}`,
      );
    }
  }, options);
}

/**
 * Asserts an element keeps a stable box *throughout* an interaction, not merely at its end.
 *
 * Before/after comparison misses the failure mode that users actually notice: a surface that jumps
 * mid-interaction and settles back. Sampling while the action runs catches the transient.
 */
export async function expectStableDuring(
  target: Locator,
  action: () => Promise<void>,
  options?: LayoutAssertionOptions & { readonly sampleIntervalMs?: number },
): Promise<void> {
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  const interval = options?.sampleIntervalMs ?? 50;
  const baseline = await readRect(target);
  let violation: string | null = null;
  let sampling = true;

  const sampler = (async () => {
    while (sampling && violation === null) {
      let current: Rect;
      try {
        current = await readRect(target);
      } catch (error) {
        violation =
          `Expected the element to stay laid out for the whole interaction, but measuring it ` +
          `failed: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      if (
        !within(current.left, baseline.left, tolerance) ||
        !within(current.top, baseline.top, tolerance) ||
        !within(current.width, baseline.width, tolerance) ||
        !within(current.height, baseline.height, tolerance)
      ) {
        violation =
          `Expected the element to hold still for the whole interaction, but it moved mid-flight.\n` +
          `  baseline: ${describeRect(baseline)}\n` +
          `  sampled:  ${describeRect(current)}`;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  })();

  try {
    await action();
  } finally {
    sampling = false;
  }
  await sampler;
  if (violation !== null) {
    fail(decorateMessage(violation, options?.message));
  }
}

function decorateMessage(message: string, prefix: string | undefined): string {
  return prefix ? `${prefix}\n${message}` : message;
}

export { expect };
