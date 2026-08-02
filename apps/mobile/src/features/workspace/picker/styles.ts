import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';
import { createWorkspacePickerBrowserStyles } from './stylesBrowser';
import { createWorkspacePickerLayoutStyles } from './stylesLayout';

export const createWorkspacePickerStyles = (theme: AppTheme) =>
  StyleSheet.create({
    ...createWorkspacePickerLayoutStyles(theme),
    ...createWorkspacePickerBrowserStyles(theme),
  });

export type WorkspacePickerStyles = ReturnType<typeof createWorkspacePickerStyles>;
