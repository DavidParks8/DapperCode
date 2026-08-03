import { resolveKeyboardInset } from './keyboardLayout';

describe('resolveKeyboardInset', () => {
  it('uses the keyboard top edge to preserve the actual app overlap', () => {
    // Captured by the iPhone 17e Appium regression: screen 844, keyboard begins at y=553.
    expect(resolveKeyboardInset(844, 553, 233)).toBe(291);
  });

  it('falls back to the reported keyboard height when its top edge is unavailable', () => {
    expect(resolveKeyboardInset(844, undefined, 233)).toBe(233);
  });

  it('never produces a negative inset from an off-screen keyboard frame', () => {
    expect(resolveKeyboardInset(844, 900, 233)).toBe(0);
  });
});
