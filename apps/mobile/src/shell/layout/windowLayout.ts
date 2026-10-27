import { TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_WIDTH } from '@shell/boot/appConstants';

export type SizeClass = 'compact' | 'regular' | 'unspecified';

export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type VerticalBarEdge = 'leading' | 'trailing' | 'unspecified';

/** Window traits React Native cannot observe on its own, reported by the native observer. */
export interface WindowTraits {
  readonly horizontalSizeClass: SizeClass;
  readonly verticalSizeClass: SizeClass;
  /**
   * Where the system lays out bars vertically, inside that edge's safe-area inset. `unspecified`
   * means bars stay horizontal: most devices, or a pose with room for them.
   */
  readonly verticalBarEdge?: VerticalBarEdge;
  /** Active regions that split the window, such as the hinge of a partially folded device. */
  readonly divisions: readonly LayoutRect[];
  /** Active regions that cover the window, such as a camera. */
  readonly occlusions?: readonly LayoutRect[];
  /** The status bar, which shares a vertical bar's column when bars are vertical. */
  readonly statusBar?: LayoutRect | null;
  /** UIKit's bar layout region, which need not be centered in the side safe-area inset. */
  readonly verticalBarLayout?: LayoutRect;
  /** Corner-aware horizontal content region while toolbar buttons occupy a side rail. */
  readonly headerLayout?: LayoutRect;
}

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export interface ShellLayout {
  /**
   * How the session list is presented:
   * - `docked`: beside the chat on a wide window.
   * - `collapsed`: a wide window where the user hid the docked list; the toggle docks it again.
   * - `overlay`: slides over the chat when opened.
   */
  readonly sidebarMode: 'docked' | 'collapsed' | 'overlay';
  readonly sidebarWidth: number;
  /** The session list spans the whole window, so every safe-area edge applies to it. */
  readonly sidebarSpansWindow: boolean;
  /**
   * Where scene toolbar buttons go:
   * - `top`: the header row, as on most devices.
   * - `leading`/`trailing`: a vertical bar in that edge's safe-area column, where the system puts
   *   its own bars (iPhone Duo closed, open in landscape, or one side of a split view).
   * - `bottom`: above the composer, on the lower half of a device folded like a laptop.
   */
  readonly toolbarPlacement: 'top' | 'leading' | 'trailing' | 'bottom';
  /** A hinge splitting the window into side-by-side pages; tappable controls should avoid it. */
  readonly fold: LayoutRect | null;
}

/** Narrowest pane either side of a fold may leave before the fold is ignored for the split. */
export const MIN_FOLD_PANE_WIDTH = 240;

const SIZE_CLASSES: readonly SizeClass[] = ['compact', 'regular', 'unspecified'];

export function resolveShellLayout(
  window: WindowSize,
  traits: WindowTraits | null,
  sidebarHidden = false,
): ShellLayout {
  const toolbarPlacement = resolveToolbarPlacement(window, traits);
  const fold = traits?.divisions.find((division) => isPaneSplittingFold(division, window.width));
  if (fold) {
    // The chat matters most, so it keeps the full width. The session list waits behind the menu
    // and, when opened, covers only the leading page, stopping before the hinge.
    return {
      sidebarMode: 'overlay',
      sidebarWidth: fold.x,
      sidebarSpansWindow: false,
      toolbarPlacement,
      fold,
    };
  }
  // Docking needs real width on every platform; a compact size class can still veto it.
  const wide = window.width >= TABLET_LAYOUT_MIN_WIDTH && traits?.horizontalSizeClass !== 'compact';
  if (!wide) {
    return {
      sidebarMode: 'overlay',
      sidebarWidth: window.width,
      sidebarSpansWindow: true,
      toolbarPlacement,
      fold: null,
    };
  }
  return {
    sidebarMode: sidebarHidden ? 'collapsed' : 'docked',
    sidebarWidth: TABLET_SIDEBAR_WIDTH,
    sidebarSpansWindow: false,
    toolbarPlacement,
    fold: null,
  };
}

function resolveToolbarPlacement(
  window: WindowSize,
  traits: WindowTraits | null,
): ShellLayout['toolbarPlacement'] {
  const edge = traits?.verticalBarEdge;
  if (edge === 'leading' || edge === 'trailing') {
    return edge;
  }
  return traits?.divisions.some((division) => isTabletopFold(division, window.height))
    ? 'bottom'
    : 'top';
}

function isPaneSplittingFold(division: LayoutRect, windowWidth: number): boolean {
  return (
    division.height > division.width &&
    division.x >= MIN_FOLD_PANE_WIDTH &&
    windowWidth - (division.x + division.width) >= MIN_FOLD_PANE_WIDTH
  );
}

function isTabletopFold(division: LayoutRect, windowHeight: number): boolean {
  return (
    division.width > division.height &&
    division.y >= MIN_FOLD_PANE_WIDTH &&
    windowHeight - (division.y + division.height) >= MIN_FOLD_PANE_WIDTH
  );
}

export interface EdgeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Gap between the system's own items (status bar, camera) and the first app control. */
export const VERTICAL_BAR_SYSTEM_GAP = 8;

/**
 * The column a vertical toolbar may occupy, in window points: the native bar region, falling back
 * to the safe-area inset, below whatever the system already shows at the top of that column.
 */
export function resolveVerticalBarFrame(
  window: WindowSize,
  traits: WindowTraits | null,
  insets: EdgeInsets,
  edge: 'leading' | 'trailing',
): LayoutRect | null {
  const { verticalBarLayout, statusBar, occlusions } = traits ?? {};
  const region =
    verticalBarLayout && fitsWindow(verticalBarLayout, window) ? verticalBarLayout : null;
  const width = region?.width ?? (edge === 'trailing' ? insets.right : insets.left);
  if (width <= 0) {
    return null;
  }
  const x = region?.x ?? (edge === 'trailing' ? window.width - width : 0);
  const systemItems = [statusBar, ...(occlusions ?? [])].filter(
    (item): item is LayoutRect =>
      item !== undefined && item !== null && item.x < x + width && item.x + item.width > x,
  );
  const top = Math.max(
    insets.top,
    region ? region.y + VERTICAL_BAR_SYSTEM_GAP : 0,
    ...systemItems.map((item) => item.y + item.height + VERTICAL_BAR_SYSTEM_GAP),
  );
  const bottom = Math.min(
    window.height - insets.bottom,
    region ? region.y + region.height : window.height,
  );
  return bottom > top ? { x, y: top, width, height: bottom - top } : null;
}

function fitsWindow(rect: LayoutRect, window: WindowSize): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= window.width &&
    rect.y + rect.height <= window.height
  );
}

export function resolveHeaderInsets(
  window: WindowSize,
  traits: WindowTraits | null,
  insets: EdgeInsets,
): Pick<EdgeInsets, 'left' | 'right'> {
  const region = traits?.headerLayout;
  if (!region || !fitsWindow(region, window) || region.y < insets.top) {
    return { left: 0, right: 0 };
  }
  return {
    left: Math.max(0, region.x - insets.left),
    right: Math.max(0, window.width - region.x - region.width - insets.right),
  };
}

export function parseWindowTraits(value: unknown): WindowTraits | null {
  if (!isRecord(value)) {
    return null;
  }
  const { horizontalSizeClass, verticalSizeClass, verticalBarEdge, divisions, occlusions } = value;
  if (!isSizeClass(horizontalSizeClass) || !isSizeClass(verticalSizeClass)) {
    return null;
  }
  return {
    horizontalSizeClass,
    verticalSizeClass,
    verticalBarEdge: VERTICAL_BAR_EDGES.includes(verticalBarEdge as VerticalBarEdge)
      ? (verticalBarEdge as VerticalBarEdge)
      : 'unspecified',
    divisions: Array.isArray(divisions) ? divisions.filter(isLayoutRect) : [],
    occlusions: Array.isArray(occlusions) ? occlusions.filter(isLayoutRect) : [],
    statusBar: isLayoutRect(value['statusBar']) ? value['statusBar'] : null,
    verticalBarLayout: isLayoutRect(value['verticalBarLayout'])
      ? value['verticalBarLayout']
      : undefined,
    headerLayout: isLayoutRect(value['headerLayout']) ? value['headerLayout'] : undefined,
  };
}

const VERTICAL_BAR_EDGES: readonly VerticalBarEdge[] = ['leading', 'trailing', 'unspecified'];

function isSizeClass(value: unknown): value is SizeClass {
  return SIZE_CLASSES.includes(value as SizeClass);
}

function isLayoutRect(value: unknown): value is LayoutRect {
  return (
    isRecord(value) &&
    [value['x'], value['y'], value['width'], value['height']].every(
      (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Widest the chat column grows: Apple's readable content width plus the transcript gutters. */
export const READABLE_COLUMN_WIDTH = 704;

/** Room to leave on each side of a scene's content so lines stay a readable length. */
export function resolveReadableColumnInset(contentWidth: number): number {
  return Math.max(0, (contentWidth - READABLE_COLUMN_WIDTH) / 2);
}

/** Widest a sheet grows; larger windows center it, as the system does on large displays. */
export const SHEET_MAX_WIDTH = 600;

/**
 * Horizontal margins for a sheet presented over the whole window. Over a fold the sheet slides
 * onto the trailing page instead of resting on the hinge.
 */
export function resolveSheetMargins(
  windowWidth: number,
  fold: LayoutRect | null,
): { readonly marginLeft: number; readonly marginRight: number } {
  if (fold) {
    return { marginLeft: fold.x + fold.width, marginRight: 0 };
  }
  const margin = Math.max(0, (windowWidth - SHEET_MAX_WIDTH) / 2);
  return { marginLeft: margin, marginRight: margin };
}
