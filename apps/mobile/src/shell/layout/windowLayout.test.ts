import { TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_WIDTH } from '@shell/boot/appConstants';

import {
  MIN_FOLD_PANE_WIDTH,
  READABLE_COLUMN_WIDTH,
  SHEET_MAX_WIDTH,
  VERTICAL_BAR_SYSTEM_GAP,
  parseWindowTraits,
  resolveHeaderInsets,
  resolveReadableColumnInset,
  resolveSheetMargins,
  resolveShellLayout,
  resolveVerticalBarFrame,
  type LayoutRect,
  type WindowTraits,
} from './windowLayout';

function size(width: number, height = 900) {
  return { width, height };
}

// Points measured on the iOS 27.1 iPhone Duo simulator.
const DUO_OUTER = { width: 466, height: 678 };
const DUO_INNER_LANDSCAPE = { width: 951, height: 669 };
const BOOK_FOLD: LayoutRect = { x: 455, y: 0, width: 41, height: 669 };

function traits(
  horizontalSizeClass: WindowTraits['horizontalSizeClass'],
  divisions: readonly LayoutRect[] = [],
): WindowTraits {
  return { horizontalSizeClass, verticalSizeClass: 'regular', divisions };
}

const OVERLAY = {
  sidebarMode: 'overlay',
  sidebarSpansWindow: true,
  toolbarPlacement: 'top',
  fold: null,
};
const DOCKED = {
  sidebarMode: 'docked',
  sidebarWidth: TABLET_SIDEBAR_WIDTH,
  sidebarSpansWindow: false,
  toolbarPlacement: 'top',
  fold: null,
};

describe('resolveShellLayout', () => {
  it.each([
    [TABLET_LAYOUT_MIN_WIDTH - 1, 'overlay'],
    [TABLET_LAYOUT_MIN_WIDTH, 'docked'],
  ])('uses the width breakpoint without native traits (%ipt)', (width, mode) => {
    expect(resolveShellLayout(size(width), null).sidebarMode).toBe(mode);
    expect(resolveShellLayout(size(width), traits('unspecified')).sidebarMode).toBe(mode);
  });

  it('keeps the closed iPhone Duo on the full-width overlay drawer', () => {
    expect(resolveShellLayout(size(DUO_OUTER.width), traits('compact'))).toEqual({
      ...OVERLAY,
      sidebarWidth: DUO_OUTER.width,
    });
  });

  it('docks the standard sidebar when iPhone Duo is fully open', () => {
    expect(resolveShellLayout(size(DUO_INNER_LANDSCAPE.width), traits('regular'))).toEqual(DOCKED);
  });

  it('keeps a narrow window on the overlay drawer even when the size class is regular', () => {
    // The open iPhone Duo held in portrait is regular width but only 669pt wide; docking would
    // leave the chat a sliver.
    expect(resolveShellLayout(size(669), traits('regular')).sidebarMode).toBe('overlay');
  });

  it('lets a compact size class veto docking on a wide window', () => {
    expect(resolveShellLayout(size(1024), traits('compact')).sidebarMode).toBe('overlay');
  });

  it('collapses the docked sidebar when the user hid it, and only on wide windows', () => {
    expect(resolveShellLayout(size(DUO_INNER_LANDSCAPE.width), traits('regular'), true)).toEqual({
      ...DOCKED,
      sidebarMode: 'collapsed',
    });
    expect(resolveShellLayout(size(DUO_OUTER.width), traits('compact'), true).sidebarMode).toBe(
      'overlay',
    );
  });

  it('keeps the chat at full width and the session list behind the menu when folded like a book', () => {
    for (const sidebarHidden of [false, true]) {
      expect(
        resolveShellLayout(
          size(DUO_INNER_LANDSCAPE.width),
          traits('regular', [BOOK_FOLD]),
          sidebarHidden,
        ),
      ).toEqual({
        sidebarMode: 'overlay',
        // Opened, the session list covers only the leading page and stops before the hinge.
        sidebarWidth: BOOK_FOLD.x,
        sidebarSpansWindow: false,
        toolbarPlacement: 'top',
        fold: BOOK_FOLD,
      });
    }
  });

  it('ignores vertical folds that cannot split the window into two usable panes', () => {
    const width = DUO_INNER_LANDSCAPE.width;
    const leadingSliver = { ...BOOK_FOLD, x: MIN_FOLD_PANE_WIDTH - 1 };
    const trailingSliver = { ...BOOK_FOLD, x: width - BOOK_FOLD.width - MIN_FOLD_PANE_WIDTH + 1 };

    for (const fold of [leadingSliver, trailingSliver]) {
      expect(resolveShellLayout(size(width), traits('regular', [fold]))).toEqual(DOCKED);
    }
  });

  it('splits around a fold reported without size classes, as Android foldables do', () => {
    // A half-open Pixel Fold reports a zero-width hinge line and no size classes.
    const hinge = { x: 420, y: 0, width: 0, height: 700 };
    expect(resolveShellLayout(size(840), traits('unspecified', [hinge]))).toEqual({
      sidebarMode: 'overlay',
      sidebarWidth: 420,
      sidebarSpansWindow: false,
      toolbarPlacement: 'top',
      fold: hinge,
    });
  });
});

describe('toolbar placement', () => {
  const LAPTOP_FOLD: LayoutRect = { x: 0, y: 455.5, width: 669, height: 40 };

  it('follows the edge where the system lays bars out vertically', () => {
    for (const edge of ['leading', 'trailing'] as const) {
      expect(
        resolveShellLayout(DUO_OUTER, { ...traits('compact'), verticalBarEdge: edge })
          .toolbarPlacement,
      ).toBe(edge);
    }
  });

  it('moves controls to the lower half of a device folded like a laptop', () => {
    expect(
      resolveShellLayout({ width: 669, height: 951 }, traits('regular', [LAPTOP_FOLD]))
        .toolbarPlacement,
    ).toBe('bottom');
  });

  it('keeps bars on top otherwise, including over a fold too close to an edge', () => {
    expect(resolveShellLayout(size(390), traits('compact')).toolbarPlacement).toBe('top');
    const lowFold = { ...LAPTOP_FOLD, y: 951 - 40 - MIN_FOLD_PANE_WIDTH + 1 };
    expect(
      resolveShellLayout({ width: 669, height: 951 }, traits('regular', [lowFold]))
        .toolbarPlacement,
    ).toBe('top');
  });
});

describe('resolveVerticalBarFrame', () => {
  // The closed iPhone Duo: the status column and the camera are reported as occlusions.
  const closed: WindowTraits = {
    ...traits('compact'),
    verticalBarEdge: 'trailing',
    occlusions: [
      { x: 399.7, y: 29.3, width: 37, height: 37 },
      { x: 382, y: 0, width: 84, height: 174 },
    ],
    statusBar: { x: 0, y: 0, width: 466, height: 2 },
  };
  const insets = { top: 0, left: 0, right: 84, bottom: 20 };

  it('starts the bar below the system items sharing its column', () => {
    expect(resolveVerticalBarFrame(DUO_OUTER, closed, insets, 'trailing')).toEqual({
      x: 382,
      y: 174 + VERTICAL_BAR_SYSTEM_GAP,
      width: 84,
      height: DUO_OUTER.height - 20 - (174 + VERTICAL_BAR_SYSTEM_GAP),
    });
  });

  it('uses the system bar region instead of centering in the wider safe-area inset', () => {
    // Measured on the open Duo: the 84pt safe-area column is centered at x909, while UIKit's
    // 48pt bar region and the system icons are centered at x903.
    const nativeLayout = { x: 879, y: 124, width: 48, height: 511 };
    const frame = resolveVerticalBarFrame(
      { width: 951, height: 669 },
      {
        ...traits('regular'),
        verticalBarEdge: 'trailing',
        verticalBarLayout: nativeLayout,
        occlusions: [{ x: 867, y: 0, width: 84, height: 124 }],
      },
      { top: 0, right: 84, bottom: 34, left: 0 },
      'trailing',
    );

    expect(frame).toEqual({ x: 879, y: 132, width: 48, height: 503 });
    expect(frame && frame.x + frame.width / 2).toBe(903);
  });

  it('uses the same system alignment on the leading edge and ignores stale out-of-window regions', () => {
    const leading = { x: 24, y: 124, width: 48, height: 511 };
    const frame = resolveVerticalBarFrame(
      { width: 951, height: 669 },
      { ...traits('regular'), verticalBarLayout: leading },
      { top: 0, right: 0, bottom: 34, left: 84 },
      'leading',
    );
    expect(frame).toEqual({ x: 24, y: 132, width: 48, height: 503 });
    expect(
      resolveVerticalBarFrame(
        DUO_OUTER,
        { ...closed, verticalBarLayout: { ...leading, x: 879 } },
        insets,
        'trailing',
      ),
    ).toEqual(resolveVerticalBarFrame(DUO_OUTER, closed, insets, 'trailing'));
  });

  it.each([
    { x: 394, y: 174, width: 0, height: 470 },
    { x: -24, y: 174, width: 48, height: 470 },
    { x: 394, y: -8, width: 48, height: 470 },
    { x: 394, y: 174, width: 48, height: -8 },
    { x: 394, y: 174, width: 48, height: 600 },
  ])('falls back while a native region does not fit the window: %p', (verticalBarLayout) => {
    expect(
      resolveVerticalBarFrame(DUO_OUTER, { ...closed, verticalBarLayout }, insets, 'trailing'),
    ).toEqual(resolveVerticalBarFrame(DUO_OUTER, closed, insets, 'trailing'));
  });

  it('ignores system items outside the column and mirrors to the leading edge', () => {
    expect(
      resolveVerticalBarFrame(DUO_OUTER, closed, { ...insets, left: 84, right: 0 }, 'leading'),
    ).toEqual({
      // Only the window-wide status bar strip reaches the leading column.
      x: 0,
      y: 2 + VERTICAL_BAR_SYSTEM_GAP,
      width: 84,
      height: DUO_OUTER.height - 20 - (2 + VERTICAL_BAR_SYSTEM_GAP),
    });
  });

  it('has no frame without an inset to live in or room below the system items', () => {
    expect(resolveVerticalBarFrame(DUO_OUTER, closed, { ...insets, right: 0 }, 'trailing')).toBe(
      null,
    );
    expect(
      resolveVerticalBarFrame({ width: 466, height: 180 }, closed, insets, 'trailing'),
    ).toBeNull();
  });
});

describe('content and sheet geometry', () => {
  it('adds only horizontal corner clearance beyond the safe area and ignores stale regions', () => {
    const window = { width: 951, height: 669 };
    const headerLayout = { x: 16, y: 0, width: 851, height: 635 };
    const reported = { ...traits('regular'), headerLayout };
    const insets = { top: 0, left: 0, right: 84, bottom: 34 };
    expect(resolveHeaderInsets(window, reported, insets)).toEqual({ left: 16, right: 0 });
    expect(
      resolveHeaderInsets(
        window,
        { ...reported, headerLayout: { ...headerLayout, x: 84 } },
        { ...insets, left: 84, right: 0 },
      ),
    ).toEqual({ left: 0, right: 16 });
    expect(resolveHeaderInsets(window, reported, { ...insets, left: 16 })).toEqual({
      left: 0,
      right: 0,
    });
    expect(resolveHeaderInsets(DUO_OUTER, reported, insets)).toEqual({ left: 0, right: 0 });
  });

  it('only narrows content wider than the readable column', () => {
    expect(resolveReadableColumnInset(READABLE_COLUMN_WIDTH - 100)).toBe(0);
    expect(resolveReadableColumnInset(867)).toBe((867 - READABLE_COLUMN_WIDTH) / 2);
  });

  it('centers sheets on wide windows and puts them on the trailing page over a fold', () => {
    expect(resolveSheetMargins(390, null)).toEqual({ marginLeft: 0, marginRight: 0 });
    expect(resolveSheetMargins(951, null)).toEqual({
      marginLeft: (951 - SHEET_MAX_WIDTH) / 2,
      marginRight: (951 - SHEET_MAX_WIDTH) / 2,
    });
    expect(resolveSheetMargins(951, BOOK_FOLD)).toEqual({ marginLeft: 496, marginRight: 0 });
  });
});

describe('parseWindowTraits', () => {
  it('retains the native corner-aware header region and rejects malformed optional regions', () => {
    const headerLayout = { x: 16, y: 0, width: 851, height: 635 };
    expect(parseWindowTraits({ ...traits('regular'), headerLayout })?.headerLayout).toEqual(
      headerLayout,
    );
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, '851', null]) {
      expect(
        parseWindowTraits({ ...traits('regular'), headerLayout: { ...headerLayout, width } })
          ?.headerLayout,
      ).toBeUndefined();
    }
  });

  it('retains the native bar layout and ignores malformed optional layouts', () => {
    const layout = { x: 879, y: 124, width: 48, height: 511 };
    expect(
      parseWindowTraits({
        ...traits('regular'),
        verticalBarLayout: layout,
      })?.verticalBarLayout,
    ).toEqual(layout);
    expect(
      parseWindowTraits({
        ...traits('regular'),
        verticalBarLayout: { ...layout, width: Number.NaN },
      })?.verticalBarLayout,
    ).toBeUndefined();
  });

  it('accepts the native observer payload', () => {
    expect(
      parseWindowTraits({
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'compact',
        divisions: [BOOK_FOLD],
      }),
    ).toEqual({
      horizontalSizeClass: 'regular',
      verticalSizeClass: 'compact',
      verticalBarEdge: 'unspecified',
      divisions: [BOOK_FOLD],
      occlusions: [],
      statusBar: null,
    });
  });

  it('drops malformed divisions without discarding the size classes', () => {
    expect(
      parseWindowTraits({
        horizontalSizeClass: 'compact',
        verticalSizeClass: 'regular',
        divisions: [null, { x: 1, y: 2, width: 3 }, { x: 0, y: 0, width: Number.NaN, height: 1 }],
      }),
    ).toMatchObject({
      horizontalSizeClass: 'compact',
      verticalSizeClass: 'regular',
      divisions: [],
    });
    expect(
      parseWindowTraits({ horizontalSizeClass: 'compact', verticalSizeClass: 'regular' }),
    ).toEqual({
      horizontalSizeClass: 'compact',
      verticalSizeClass: 'regular',
      verticalBarEdge: 'unspecified',
      divisions: [],
      occlusions: [],
      statusBar: null,
    });
  });

  it('reads the vertical bar edge, occlusions, and status bar, dropping unknown edges', () => {
    const status = { x: 0, y: 0, width: 466, height: 2 };
    expect(
      parseWindowTraits({
        horizontalSizeClass: 'compact',
        verticalSizeClass: 'regular',
        verticalBarEdge: 'trailing',
        divisions: [],
        occlusions: [BOOK_FOLD, { x: 'bad' }],
        statusBar: status,
      }),
    ).toMatchObject({ verticalBarEdge: 'trailing', occlusions: [BOOK_FOLD], statusBar: status });
    expect(
      parseWindowTraits({
        horizontalSizeClass: 'compact',
        verticalSizeClass: 'regular',
        verticalBarEdge: 'top',
      })?.verticalBarEdge,
    ).toBe('unspecified');
  });

  it.each([
    null,
    'regular',
    { horizontalSizeClass: 'huge', verticalSizeClass: 'regular' },
    { horizontalSizeClass: 'regular', verticalSizeClass: 4 },
  ])('rejects an unrecognised payload (%p)', (payload) => {
    expect(parseWindowTraits(payload)).toBeNull();
  });
});
