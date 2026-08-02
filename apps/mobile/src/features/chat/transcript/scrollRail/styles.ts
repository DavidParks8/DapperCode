import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';
import {
  CHAT_SCROLL_RAIL_BAR_HEIGHT,
  CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH,
  CHAT_SCROLL_RAIL_HORIZONTAL_PADDING,
} from './geometry';

export function createChatScrollRailStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      width: CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH + CHAT_SCROLL_RAIL_HORIZONTAL_PADDING * 2,
      zIndex: 3,
    },
    clip: {
      position: 'absolute',
      right: CHAT_SCROLL_RAIL_HORIZONTAL_PADDING,
      width: CHAT_SCROLL_RAIL_ENGAGED_MAX_WIDTH,
      overflow: 'hidden',
    },
    bar: {
      position: 'absolute',
      right: 0,
      top: 0,
      height: CHAT_SCROLL_RAIL_BAR_HEIGHT,
      borderRadius: CHAT_SCROLL_RAIL_BAR_HEIGHT / 2,
      backgroundColor: theme.colors.textMuted,
    },
  });
}
