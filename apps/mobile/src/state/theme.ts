import { atom } from 'jotai';
import type { ColorSchemeName } from 'react-native';

import { DEFAULT_FONT_PREFERENCE } from '../fonts';
import { createAppTheme, resolveThemeMode } from '../theme';
import { appSettingsAtom } from './appState/atoms';
import { darkUiPaletteAtom, fontPreferenceAtom } from './appState/settings';

export const systemColorSchemeAtom = atom<ColorSchemeName>('unspecified');

export const fontsLoadedAtom = atom(false);

export const themeModeAtom = atom((get) =>
  resolveThemeMode(get(appSettingsAtom).appearancePreference, get(systemColorSchemeAtom))
);

/**
 * Depends on scalar atoms only, so unrelated settings writes (remembered threads, recent preview
 * targets, default cwd) never produce a new theme object.
 */
export const themeAtom = atom((get) => {
  const mode = get(themeModeAtom);
  const fontPreference = get(fontsLoadedAtom) ? get(fontPreferenceAtom) : DEFAULT_FONT_PREFERENCE;
  const palette = mode === 'dark' ? get(darkUiPaletteAtom) : 'classic';
  return createAppTheme(mode, fontPreference, palette);
});
