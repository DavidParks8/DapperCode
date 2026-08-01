import type { AppTheme } from '../../theme';
import { createBrowserScreenLayoutStyles } from './browserScreenStylesLayout';
import { createBrowserScreenStartStyles } from './browserScreenStylesStart';

export const createBrowserScreenStyles = (theme: AppTheme) => ({
  ...createBrowserScreenLayoutStyles(theme),
  ...createBrowserScreenStartStyles(theme),
});
