import { resolveResponseUsagePlacement } from './ResponseUsageOverlay';
import { resolvePourOrigin } from './responseUsagePour';

const WINDOW = { width: 390, height: 844 };
const INSETS = { top: 59, bottom: 34 };
const PANEL = { width: 180, height: 96 };

function placeAt(anchor: { x: number; y: number; width?: number; height?: number }) {
  return resolveResponseUsagePlacement({
    anchor: { width: 30, height: 30, ...anchor },
    panel: PANEL,
    window: WINDOW,
    insets: INSETS,
  });
}

describe('resolveResponseUsagePlacement', () => {
  it('sits above the anchor and lines up with its left edge', () => {
    const placement = placeAt({ x: 24, y: 500 });
    expect(placement.top).toBe(500 - 8 - PANEL.height);
    expect(placement.left).toBe(24);
  });

  it('flips below the anchor when the space above cannot hold the panel', () => {
    // A response near the top of the transcript leaves nothing above its action row.
    const placement = placeAt({ x: 24, y: 80 });
    expect(placement.top).toBe(80 + 30 + 8);
  });

  it('keeps a flipped panel clear of the bottom inset', () => {
    const placement = placeAt({ x: 24, y: 100, height: 700 });
    expect(placement.top).toBe(WINDOW.height - INSETS.bottom - 12 - PANEL.height);
  });

  it('pulls the panel back inside the right edge of the screen', () => {
    const placement = placeAt({ x: 340, y: 500 });
    expect(placement.left).toBe(WINDOW.width - 12 - PANEL.width);
    expect(placement.left + PANEL.width).toBeLessThanOrEqual(WINDOW.width);
  });

  it('never crosses the left edge, whatever the anchor reports', () => {
    expect(placeAt({ x: -40, y: 500 }).left).toBe(12);
  });

  it('caps the panel width to the screen so long model names cannot push it off', () => {
    expect(placeAt({ x: 24, y: 500 }).maxWidth).toBe(WINDOW.width - 24);
  });

  it('treats an unmeasured panel as having no size rather than crashing', () => {
    const placement = resolveResponseUsagePlacement({
      anchor: { x: 24, y: 500, width: 30, height: 30 },
      panel: null,
      window: WINDOW,
      insets: INSETS,
    });
    expect(placement.top).toBe(492);
    expect(placement.left).toBe(24);
  });

  it('reports which side of the anchor it settled on', () => {
    expect(placeAt({ x: 24, y: 500 }).placedAbove).toBe(true);
    expect(placeAt({ x: 24, y: 80 }).placedAbove).toBe(false);
  });
});

describe('resolvePourOrigin', () => {
  const anchor = { x: 24, y: 500, width: 30, height: 30 };

  it('grows the panel out of the edge facing its button', () => {
    expect(resolvePourOrigin({ anchor, left: 24, panel: PANEL, placedAbove: true })).toEqual({
      x: 15,
      y: PANEL.height,
    });
    expect(resolvePourOrigin({ anchor, left: 24, panel: PANEL, placedAbove: false })).toEqual({
      x: 15,
      y: 0,
    });
  });

  it('keeps the origin inside a panel that had to slide away from its anchor', () => {
    // A button near the right edge leaves the panel pulled back inside the screen, and an origin
    // beyond the panel would fling the glass in from off screen.
    const shifted = resolvePourOrigin({
      anchor: { ...anchor, x: 380 },
      left: 198,
      panel: PANEL,
      placedAbove: true,
    });
    expect(shifted.x).toBe(PANEL.width);
    expect(
      resolvePourOrigin({
        anchor: { ...anchor, x: -40 },
        left: 12,
        panel: PANEL,
        placedAbove: true,
      }).x,
    ).toBe(0);
  });

  it('falls back to the middle while the anchor is still unmeasured', () => {
    expect(resolvePourOrigin({ anchor: null, left: 12, panel: PANEL, placedAbove: true })).toEqual({
      x: PANEL.width / 2,
      y: PANEL.height / 2,
    });
  });
});
