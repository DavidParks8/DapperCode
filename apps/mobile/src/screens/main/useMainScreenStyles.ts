import { useMemo } from 'react';

import { useAppTheme, type AppTheme } from '../../theme';
import { createStyles } from './mainScreenStyles';

export type MainScreenStyles = ReturnType<typeof createStyles>;

/**
 * MainScreen's theme and stylesheet. Views read these directly instead of receiving them
 * through the accumulated context.
 */
export function useMainScreenStyles(): { theme: AppTheme; styles: MainScreenStyles } {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return { theme, styles };
}
