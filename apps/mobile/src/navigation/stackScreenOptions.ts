import type { AppTheme } from '../theme';

export function createStackScreenOptions(theme: AppTheme) {
  return {
    headerShown: false,
    contentStyle: { backgroundColor: theme.colors.bgMain },
  } as const;
}
