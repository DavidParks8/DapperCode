import { atom } from 'jotai';
import type { ColorSchemeName } from 'react-native';

import { DEFAULT_FONT_PREFERENCE } from '../fonts';
import { createAppTheme, resolveThemeMode } from '../theme';
import { appSettingsAtom } from './appState/atoms';

export const systemColorSchemeAtom = atom<ColorSchemeName>('unspecified');

export const fontsLoadedAtom = atom(false);

export const themeModeAtom = atom((get) =>
  resolveThemeMode(get(appSettingsAtom).appearancePreference, get(systemColorSchemeAtom))
);

export const themeAtom = atom((get) => {
  const settings = get(appSettingsAtom);
  const mode = get(themeModeAtom);
  const fontPreference = get(fontsLoadedAtom) ? settings.fontPreference : DEFAULT_FONT_PREFERENCE;
  return createAppTheme(mode, fontPreference, mode === 'dark' ? settings.darkUiPalette : 'classic');
});
