import type { AppTheme } from '@shared/theme';

export function createStackScreenOptions(theme: AppTheme) {
  return {
    headerShown: false,
    contentStyle: { backgroundColor: theme.colors.bgMain },
  } as const;
}
