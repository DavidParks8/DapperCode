import type { Locator, Page } from '@playwright/test';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly centerX: number;
  readonly centerY: number;
}

export interface ElementGeometry {
  readonly rect: Rect;
  /** True when the element renders at a non-zero size and is not hidden by styles. */
  readonly visible: boolean;
}

export function toRect(box: Box): Rect {
  return {
    ...box,
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    centerX: box.x + box.width / 2,
    centerY: box.y + box.height / 2,
  };
}

/**
 * Reads a laid-out rectangle for a single element.
 *
 * Layout is read after the browser has settled two animation frames so transitions, reanimated
 * driven transforms, and font swaps do not produce a half-applied measurement.
 */
export async function readRect(target: Locator): Promise<Rect> {
  await settleLayout(target.page());
  const box = await target.boundingBox();
  if (!box) {
    throw new Error('Element is not rendered, so it has no layout box to measure.');
  }
  return toRect(box);
}

export async function readRects(targets: Locator): Promise<Rect[]> {
  await settleLayout(targets.page());
  const count = await targets.count();
  const rects: Rect[] = [];
  for (let index = 0; index < count; index += 1) {
    const box = await targets.nth(index).boundingBox();
    if (box) {
      rects.push(toRect(box));
    }
  }
  return rects;
}

/** Reads the element's rectangle and style-aware visibility. */
export async function readGeometry(target: Locator): Promise<ElementGeometry> {
  await settleLayout(target.page());
  const measured = await target.evaluate((node) => {
    const element = node as HTMLElement;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      hidden:
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity) === 0,
    };
  });

  return {
    rect: toRect(measured),
    visible: !measured.hidden && measured.width > 0 && measured.height > 0,
  };
}

export async function readViewportRect(page: Page): Promise<Rect> {
  const size = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  return toRect({ x: 0, y: 0, ...size });
}

/** Vertical distance between the bottom of `first` and the top of `second`. Negative means overlap. */
export function verticalGap(first: Rect, second: Rect): number {
  return second.top - first.bottom;
}

/** Horizontal distance between the right of `first` and the left of `second`. Negative means overlap. */
export function horizontalGap(first: Rect, second: Rect): number {
  return second.left - first.right;
}

export function intersection(first: Rect, second: Rect): Rect | null {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right <= left || bottom <= top) {
    return null;
  }
  return toRect({ x: left, y: top, width: right - left, height: bottom - top });
}

export function overlapArea(first: Rect, second: Rect): number {
  const region = intersection(first, second);
  return region ? region.width * region.height : 0;
}

export function contains(outer: Rect, inner: Rect, tolerance = 0.5): boolean {
  return (
    inner.left >= outer.left - tolerance &&
    inner.top >= outer.top - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}

export function describeRect(rect: Rect): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  return `x=${String(round(rect.left))} y=${String(round(rect.top))} w=${String(
    round(rect.width),
  )} h=${String(round(rect.height))} (right=${String(round(rect.right))}, bottom=${String(
    round(rect.bottom),
  )})`;
}

/**
 * Waits for layout to stop changing.
 *
 * Two consecutive animation frames plus a stable document height is enough to outlast style
 * recalculation and the short entrance transitions used by the shell, without the flakiness of a
 * fixed sleep.
 */
export async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}
