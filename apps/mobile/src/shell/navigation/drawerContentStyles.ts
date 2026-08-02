import type { AppTheme } from '@shared/theme';
import { createDrawerContentShellStyles } from '@shell/navigation/drawerContentShellStyles';
import { createDrawerContentFilterListStyles } from '@shell/navigation/drawerContentFilterListStyles';
import { createDrawerContentWorkspaceRowStyles } from '@shell/navigation/drawerContentWorkspaceRowStyles';

export type DrawerContentStyles = ReturnType<typeof createDrawerContentShellStyles> &
  ReturnType<typeof createDrawerContentFilterListStyles> &
  ReturnType<typeof createDrawerContentWorkspaceRowStyles>;

export function createDrawerContentStyles(theme: AppTheme): DrawerContentStyles {
  return {
    ...createDrawerContentShellStyles(theme),
    ...createDrawerContentFilterListStyles(theme),
    ...createDrawerContentWorkspaceRowStyles(theme),
  };
}
