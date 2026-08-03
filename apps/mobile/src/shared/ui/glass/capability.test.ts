import { Platform } from 'react-native';

import {
  resetMockGlassEffect,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { isGlassAvailable } from '@shared/ui/glass/capability';

function setPlatformOs(value: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

describe('isGlassAvailable', () => {
  const originalPlatformOs = Platform.OS;

  beforeEach(() => {
    resetMockGlassEffect();
    setPlatformOs('ios');
  });

  afterEach(() => {
    setPlatformOs(originalPlatformOs);
  });

  it('requires iOS even when both native capability checks pass', () => {
    setPlatformOs('android');
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);

    expect(isGlassAvailable()).toBe(false);
  });

  it('requires the Liquid Glass design to be available', () => {
    setMockGlassEffectAPIAvailable(true);

    expect(isGlassAvailable()).toBe(false);
  });

  it('requires the runtime Glass Effect API to be available', () => {
    setMockLiquidGlassAvailable(true);

    expect(isGlassAvailable()).toBe(false);
  });

  it('enables glass when both iOS capability checks pass', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);

    expect(isGlassAvailable()).toBe(true);
  });
});
