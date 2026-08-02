import type { AppTheme } from '@shared/theme';
import { createBrowserScreenLayoutStyles } from './stylesLayout';
import { createBrowserScreenStartStyles } from './stylesStart';

export const createBrowserScreenStyles = (theme: AppTheme) => ({
  ...createBrowserScreenLayoutStyles(theme),
  ...createBrowserScreenStartStyles(theme),
});
