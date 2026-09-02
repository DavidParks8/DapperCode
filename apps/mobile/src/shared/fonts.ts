import { Platform } from 'react-native';

const SYSTEM_MONO_FAMILY = Platform.select({ ios: 'Menlo', default: 'monospace' }) ?? 'monospace';

/**
 * The app uses the platform UI font for all text, so only monospace families are
 * pinned here (code blocks and terminal-style text still need a mono face).
 */
export const SYSTEM_FONT_FAMILIES = {
  monoRegular: SYSTEM_MONO_FAMILY,
};

export type AppFontFamilies = typeof SYSTEM_FONT_FAMILIES;
