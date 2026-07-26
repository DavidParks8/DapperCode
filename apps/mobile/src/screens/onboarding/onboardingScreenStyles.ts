import type { AppTheme } from '../../theme';
import { createOnboardingBaseStyles } from './onboardingScreenStylesBase';
import { createOnboardingFormStyles } from './onboardingScreenStylesForm';
import { createOnboardingLayoutStyles } from './onboardingScreenStylesLayout';
import { createOnboardingScannerStyles } from './onboardingScreenStylesScanner';
import { createOnboardingStyleTokens } from './onboardingScreenStyleTokens';

export const createOnboardingStyles = (theme: AppTheme) => {
  const tokens = createOnboardingStyleTokens(theme);
  return {
    ...createOnboardingBaseStyles(theme, tokens),
    ...createOnboardingLayoutStyles(theme),
    ...createOnboardingFormStyles(theme, tokens),
    ...createOnboardingScannerStyles(theme, tokens),
  };
};
