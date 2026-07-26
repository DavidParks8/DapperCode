import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';
import { createBrowserScreenLayoutStyles } from './browserScreenStylesLayout';
import { createBrowserScreenStartStyles } from './browserScreenStylesStart';

export const createBrowserScreenStyles = (theme: AppTheme) =>
  StyleSheet.create({
    ...createBrowserScreenLayoutStyles(theme),
    ...createBrowserScreenStartStyles(theme),
  });
