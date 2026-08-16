import { isUserPresentAppState, supportsNativePushPresence } from '@shell/session/appVisibility';

describe('app visibility', () => {
  it('keeps transient inactive states present but treats background as absent', () => {
    expect(isUserPresentAppState('active')).toBe(true);
    expect(isUserPresentAppState('inactive')).toBe(true);
    expect(isUserPresentAppState('background')).toBe(false);
  });

  it('allows only native phone platforms to hold global push presence', () => {
    expect(supportsNativePushPresence('ios')).toBe(true);
    expect(supportsNativePushPresence('android')).toBe(true);
    expect(supportsNativePushPresence('web')).toBe(false);
    expect(supportsNativePushPresence('windows')).toBe(false);
  });
});
