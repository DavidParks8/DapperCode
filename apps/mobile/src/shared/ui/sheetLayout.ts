/**
 * Layout maths shared by the app's bottom sheets.
 *
 * These live outside the components so the touch-target and safe-area guarantees they encode can
 * be asserted directly, instead of being inferred from a rendered style blob.
 */

/** Minimum interactive target recommended by both Apple HIG and Material, in points. */
export const MIN_TOUCH_TARGET = 44;

/** Height of the drag indicator pill drawn inside a sheet handle. */
export const SHEET_HANDLE_INDICATOR_HEIGHT = 5;

/** Width of the drag indicator pill. */
export const SHEET_HANDLE_INDICATOR_WIDTH = 44;

/**
 * Clearance kept between sheet content and the bottom edge of the display.
 *
 * Phones round off the corners of the screen, so a control flush against the sheet's bottom edge
 * gets visually clipped on devices that report a small (or zero) bottom safe-area inset.
 */
export const SHEET_CORNER_CLEARANCE = 16;

/**
 * Padding above and below the drag indicator so the handle is a full touch target.
 *
 * The stock handle is only 24pt tall, which is small enough that a drag aimed at it lands on the
 * scrollable sheet content instead and scrolls the list.
 */
export function sheetHandleVerticalPadding(
  indicatorHeight: number,
  minTouchTarget: number,
): number {
  return Math.max(0, Math.ceil((minTouchTarget - indicatorHeight) / 2));
}

/** Total height of the sheet handle, including the padding that makes up its touch target. */
export function sheetHandleHeight(indicatorHeight: number, minTouchTarget: number): number {
  return indicatorHeight + sheetHandleVerticalPadding(indicatorHeight, minTouchTarget) * 2;
}

/** Bottom padding for sheet content that keeps controls clear of the display's rounded corners. */
export function sheetContentBottomPadding(
  bottomInset: number,
  basePadding: number,
  extraInset: number,
): number {
  return (
    Math.max(bottomInset, SHEET_CORNER_CLEARANCE) +
    Math.max(0, basePadding) +
    Math.max(0, extraInset)
  );
}

/** Horizontal padding for sheet content that respects a landscape notch or curved edge. */
export function sheetContentHorizontalPadding(edgeInset: number, basePadding: number): number {
  return Math.max(0, basePadding) + Math.max(0, edgeInset);
}
