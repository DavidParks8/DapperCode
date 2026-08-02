jest.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

import { AccessibilityInfo, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

import { feedback, isHapticsSupportedPlatform, isReduceMotionPreferred } from '@shared/feedback';

const mockHaptics = Haptics as unknown as {
  selectionAsync: jest.Mock;
  impactAsync: jest.Mock;
  notificationAsync: jest.Mock;
};

function setPlatformOs(value: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

describe('feedback helpers', () => {
  const originalOs = Platform.OS;

  afterEach(() => {
    setPlatformOs(originalOs);
    jest.clearAllMocks();
  });

  it('reports haptics support per platform', () => {
    expect(isHapticsSupportedPlatform('ios')).toBe(true);
    expect(isHapticsSupportedPlatform('android')).toBe(true);
    expect(isHapticsSupportedPlatform('web')).toBe(false);
  });

  it('maps each semantic action to its native haptic call', async () => {
    setPlatformOs('ios');

    await feedback.selection();
    expect(mockHaptics.selectionAsync).toHaveBeenCalledTimes(1);

    await feedback.send();
    expect(mockHaptics.impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Light);

    await feedback.success();
    expect(mockHaptics.notificationAsync).toHaveBeenLastCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );

    await feedback.warning();
    expect(mockHaptics.notificationAsync).toHaveBeenLastCalledWith(
      Haptics.NotificationFeedbackType.Warning,
    );

    await feedback.error();
    expect(mockHaptics.notificationAsync).toHaveBeenLastCalledWith(
      Haptics.NotificationFeedbackType.Error,
    );

    await feedback.destructive();
    expect(mockHaptics.impactAsync).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Heavy);
  });

  it('no-ops on web without calling the native haptics module', async () => {
    setPlatformOs('web');

    await feedback.selection();
    await feedback.success();

    expect(mockHaptics.selectionAsync).not.toHaveBeenCalled();
    expect(mockHaptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('swallows only the known unavailable-platform error', async () => {
    setPlatformOs('ios');
    mockHaptics.selectionAsync.mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 'ERR_UNAVAILABLE' }),
    );

    await expect(feedback.selection()).resolves.toBeUndefined();
  });

  it('does not swallow unrelated haptics errors', async () => {
    setPlatformOs('ios');
    mockHaptics.selectionAsync.mockRejectedValueOnce(new Error('boom'));

    await expect(feedback.selection()).rejects.toThrow('boom');
  });

  it('still fires haptics while Reduce Motion is enabled', async () => {
    setPlatformOs('ios');
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);

    await expect(isReduceMotionPreferred()).resolves.toBe(true);
    await feedback.success();
    expect(mockHaptics.notificationAsync).toHaveBeenCalledTimes(1);
  });

  it('defaults reduce motion preference to false when unsupported', async () => {
    const original = AccessibilityInfo.isReduceMotionEnabled;
    // @ts-expect-error - simulating a platform without this accessibility API.
    delete AccessibilityInfo.isReduceMotionEnabled;

    await expect(isReduceMotionPreferred()).resolves.toBe(false);

    AccessibilityInfo.isReduceMotionEnabled = original;
  });
});
