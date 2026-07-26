import { StyleSheet } from 'react-native';

import type { AppTheme } from '../theme';
import { createWorkspacePickerBrowserStyles } from './workspacePickerStylesBrowser';
import { createWorkspacePickerLayoutStyles } from './workspacePickerStylesLayout';

export const createWorkspacePickerStyles = (theme: AppTheme) =>
  StyleSheet.create({
    ...createWorkspacePickerLayoutStyles(theme),
    ...createWorkspacePickerBrowserStyles(theme),
  });

export type WorkspacePickerStyles = ReturnType<typeof createWorkspacePickerStyles>;
