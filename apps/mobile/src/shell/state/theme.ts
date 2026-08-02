import { atom } from 'jotai';
import type { ColorSchemeName } from 'react-native';

import { createAppTheme, resolveThemeMode } from '@shared/theme';
import { appSettingsAtom } from '@shell/state/appState/atoms';
import { darkUiPaletteAtom } from '@shell/state/appState/settings';

export const systemColorSchemeAtom = atom<ColorSchemeName>('unspecified');

export const themeModeAtom = atom((get) =>
  resolveThemeMode(get(appSettingsAtom).appearancePreference, get(systemColorSchemeAtom)),
);

/**
 * Depends on scalar atoms only, so unrelated settings writes (remembered threads, recent preview
 * targets, default cwd) never produce a new theme object.
 */
export const themeAtom = atom((get) => {
  const mode = get(themeModeAtom);
  const palette = mode === 'dark' ? get(darkUiPaletteAtom) : 'classic';
  return createAppTheme(mode, palette);
});
