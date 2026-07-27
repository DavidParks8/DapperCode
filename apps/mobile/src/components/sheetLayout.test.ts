import {
  MIN_TOUCH_TARGET,
  SHEET_CORNER_CLEARANCE,
  SHEET_HANDLE_INDICATOR_HEIGHT,
  SHEET_HANDLE_INDICATOR_WIDTH,
  sheetContentBottomPadding,
  sheetContentHorizontalPadding,
  sheetHandleHeight,
  sheetHandleVerticalPadding,
} from './sheetLayout';

describe('sheetLayout constants', () => {
  it('keeps the shared touch target at the platform minimum', () => {
    expect(MIN_TOUCH_TARGET).toBe(44);
  });

  it('keeps the corner clearance large enough to escape a rounded display corner', () => {
    expect(SHEET_CORNER_CLEARANCE).toBeGreaterThanOrEqual(16);
  });

  it('draws a grab indicator that is visible without being the whole target', () => {
    expect(SHEET_HANDLE_INDICATOR_HEIGHT).toBeGreaterThan(0);
    expect(SHEET_HANDLE_INDICATOR_HEIGHT).toBeLessThan(MIN_TOUCH_TARGET);
    expect(SHEET_HANDLE_INDICATOR_WIDTH).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });
});

describe('sheetHandleVerticalPadding', () => {
  it('pads a thin indicator out to a full touch target', () => {
    expect(sheetHandleVerticalPadding(SHEET_HANDLE_INDICATOR_HEIGHT, MIN_TOUCH_TARGET)).toBe(20);
    expect(
      sheetHandleHeight(SHEET_HANDLE_INDICATOR_HEIGHT, MIN_TOUCH_TARGET),
    ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  it('rounds up so an odd remainder never lands a point short of the target', () => {
    expect(sheetHandleVerticalPadding(5, 44)).toBe(20);
    expect(sheetHandleHeight(5, 44)).toBe(45);
    expect(sheetHandleVerticalPadding(4, 44)).toBe(20);
    expect(sheetHandleHeight(4, 44)).toBe(44);
    expect(sheetHandleVerticalPadding(3, 44)).toBe(21);
    expect(sheetHandleHeight(3, 44)).toBe(45);
  });

  it('adds no padding once the indicator already fills the target', () => {
    expect(sheetHandleVerticalPadding(44, 44)).toBe(0);
    expect(sheetHandleHeight(44, 44)).toBe(44);
    expect(sheetHandleVerticalPadding(48, 44)).toBe(0);
    expect(sheetHandleHeight(48, 44)).toBe(48);
  });

  it('never shrinks the handle below the requested target for any indicator height', () => {
    for (let indicatorHeight = 1; indicatorHeight <= 60; indicatorHeight += 1) {
      expect(sheetHandleHeight(indicatorHeight, MIN_TOUCH_TARGET)).toBeGreaterThanOrEqual(
        Math.min(indicatorHeight, MIN_TOUCH_TARGET),
      );
      expect(sheetHandleHeight(indicatorHeight, MIN_TOUCH_TARGET)).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET,
      );
    }
  });
});

describe('sheetContentBottomPadding', () => {
  it('stacks the base padding on top of a reported home-indicator inset', () => {
    expect(sheetContentBottomPadding(34, 16, 0)).toBe(50);
  });

  it('falls back to the corner clearance when the device reports no bottom inset', () => {
    expect(sheetContentBottomPadding(0, 16, 0)).toBe(SHEET_CORNER_CLEARANCE + 16);
  });

  it('uses the corner clearance whenever it beats the reported inset', () => {
    expect(sheetContentBottomPadding(8, 16, 0)).toBe(SHEET_CORNER_CLEARANCE + 16);
    expect(sheetContentBottomPadding(SHEET_CORNER_CLEARANCE, 16, 0)).toBe(
      SHEET_CORNER_CLEARANCE + 16,
    );
    expect(sheetContentBottomPadding(SHEET_CORNER_CLEARANCE + 1, 16, 0)).toBe(
      SHEET_CORNER_CLEARANCE + 17,
    );
  });

  it('adds a caller supplied extra inset', () => {
    expect(sheetContentBottomPadding(34, 16, 12)).toBe(62);
  });

  it('ignores negative base and extra insets instead of eating the clearance', () => {
    expect(sheetContentBottomPadding(34, 16, -20)).toBe(50);
    expect(sheetContentBottomPadding(34, -8, 0)).toBe(34);
    expect(sheetContentBottomPadding(-40, 16, 0)).toBe(SHEET_CORNER_CLEARANCE + 16);
  });

  it('always clears the corner by at least the clearance', () => {
    for (const bottomInset of [-10, 0, 3, 16, 21, 34, 48]) {
      expect(sheetContentBottomPadding(bottomInset, 16, 0)).toBeGreaterThanOrEqual(
        SHEET_CORNER_CLEARANCE,
      );
    }
  });
});

describe('sheetContentHorizontalPadding', () => {
  it('keeps the base padding when there is no side inset', () => {
    expect(sheetContentHorizontalPadding(0, 16)).toBe(16);
  });

  it('adds a landscape notch inset to the base padding', () => {
    expect(sheetContentHorizontalPadding(44, 16)).toBe(60);
  });

  it('ignores negative insets and negative base padding', () => {
    expect(sheetContentHorizontalPadding(-5, 16)).toBe(16);
    expect(sheetContentHorizontalPadding(44, -3)).toBe(44);
    expect(sheetContentHorizontalPadding(-5, -3)).toBe(0);
  });
});
