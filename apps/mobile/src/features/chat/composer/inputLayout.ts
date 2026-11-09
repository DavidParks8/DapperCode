import { spacing } from '@shared/theme';

const IOS_HOME_INDICATOR_THRESHOLD = 20;

/** The composer's round Send/Stop button. */
export const COMPOSER_ACTION_SIZE = 48;

export interface ComposerBottomSpacing {
  baseBottomPadding: number;
  extraBottomInset: number;
  totalBottomPadding: number;
}

export function resolveComposerBottomSpacing(
  platform: string,
  safeAreaBottomInset: number,
  keyboardVisible: boolean,
): ComposerBottomSpacing {
  const normalizedInset = Number.isFinite(safeAreaBottomInset)
    ? Math.max(0, safeAreaBottomInset)
    : 0;

  const baseBottomPadding = resolveBaseBottomPadding(platform, keyboardVisible);
  const extraBottomInset = keyboardVisible
    ? 0
    : resolveRestingBottomInset(platform, normalizedInset);

  return {
    baseBottomPadding,
    extraBottomInset,
    totalBottomPadding: baseBottomPadding + extraBottomInset,
  };
}

/**
 * How far above a footerless composer's bottom edge its Send/Stop button reaches. The button rests
 * on the input box's bottom edge, which sits on the composer's bottom padding.
 */
export function resolveComposerActionReach(
  platform: string,
  safeAreaBottomInset: number,
  keyboardVisible: boolean,
): number {
  return (
    resolveComposerBottomSpacing(platform, safeAreaBottomInset, keyboardVisible)
      .totalBottomPadding + COMPOSER_ACTION_SIZE
  );
}

function resolveBaseBottomPadding(platform: string, keyboardVisible: boolean): number {
  if (platform === 'ios') {
    return keyboardVisible ? spacing.sm : spacing.xs + 2;
  }

  if (platform === 'android') {
    return keyboardVisible ? 0 : spacing.sm;
  }

  return keyboardVisible ? 0 : spacing.sm;
}

function resolveRestingBottomInset(platform: string, safeAreaBottomInset: number): number {
  if (platform === 'ios') {
    return safeAreaBottomInset >= IOS_HOME_INDICATOR_THRESHOLD ? safeAreaBottomInset : 0;
  }

  if (platform === 'android') {
    return safeAreaBottomInset;
  }

  return safeAreaBottomInset;
}
