import { computeHitSlop, resolveMinimumTouchTarget, touchTarget } from '@shared/ui/touchTarget';

describe('touchTarget', () => {
  it('re-exports the canonical per-platform minimums from theme.ts', () => {
    expect(resolveMinimumTouchTarget('ios')).toBe(touchTarget.ios44);
    expect(resolveMinimumTouchTarget('android')).toBe(touchTarget.android48);
    expect(resolveMinimumTouchTarget('web')).toBe(touchTarget.web44);
  });

  describe('computeHitSlop', () => {
    it('pads a visually compact square control up to the platform minimum', () => {
      const minimum = resolveMinimumTouchTarget('ios');
      const slop = computeHitSlop({ width: 30, height: 30 }, undefined);
      const expectedPad = Math.ceil((minimum - 30) / 2);
      expect(slop).toEqual({
        top: expectedPad,
        bottom: expectedPad,
        left: expectedPad,
        right: expectedPad,
      });
    });

    it('never returns negative slop for a control already at or above the minimum', () => {
      const slop = computeHitSlop({ width: 60, height: 60 });
      expect(slop).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    });

    it('caps slop per-axis so packed sibling controls do not gain overlapping hit areas', () => {
      const slop = computeHitSlop({ width: 20, height: 20 }, { maxHorizontal: 2, maxVertical: 3 });
      expect(slop.left).toBeLessThanOrEqual(2);
      expect(slop.right).toBeLessThanOrEqual(2);
      expect(slop.top).toBeLessThanOrEqual(3);
      expect(slop.bottom).toBeLessThanOrEqual(3);
    });

    it('supports a stricter local minimum without changing platform defaults', () => {
      expect(computeHitSlop({ width: 36, height: 36 }, { minimum: 48 })).toEqual({
        top: 6,
        bottom: 6,
        left: 6,
        right: 6,
      });
    });
  });
});
