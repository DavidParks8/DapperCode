import type { AppTheme } from '@shared/theme';
import { createOnboardingBaseStyles } from './stylesBase';
import { createOnboardingFormStyles } from './stylesForm';
import { createOnboardingLayoutStyles } from './stylesLayout';
import { createOnboardingScannerStyles } from './stylesScanner';
import { createOnboardingStyleTokens } from './styleTokens';

export const createOnboardingStyles = (theme: AppTheme) => {
  const tokens = createOnboardingStyleTokens(theme);
  return {
    ...createOnboardingBaseStyles(theme, tokens),
    ...createOnboardingLayoutStyles(theme),
    ...createOnboardingFormStyles(theme, tokens),
    ...createOnboardingScannerStyles(theme, tokens),
  };
};
