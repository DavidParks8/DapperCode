import { useAtomValue } from 'jotai';
import { useContext } from 'react';
import { useWindowDimensions } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import {
  resolveHeaderInsets,
  resolveReadableColumnInset,
  resolveSheetMargins,
  resolveShellLayout,
  resolveVerticalBarFrame,
  type LayoutRect,
  type ShellLayout,
} from '@shell/layout/windowLayout';
import { sidebarHiddenAtom } from '@shell/state/appState/settings';
import { windowTraitsAtom } from '@shell/state/layout/atoms';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

export function useShellLayout(): ShellLayout {
  const { width, height } = useWindowDimensions();
  const traits = useAtomValue(windowTraitsAtom);
  const sidebarHidden = useAtomValue(sidebarHiddenAtom);
  return resolveShellLayout({ width, height }, traits, sidebarHidden);
}

/** The window-space column for a vertical toolbar, or `null` when toolbars are horizontal. */
export function useVerticalBarFrame(): LayoutRect | null {
  const { width, height } = useWindowDimensions();
  const traits = useAtomValue(windowTraitsAtom);
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  const { toolbarPlacement } = useShellLayout();
  if (toolbarPlacement !== 'leading' && toolbarPlacement !== 'trailing') {
    return null;
  }
  return resolveVerticalBarFrame({ width, height }, traits, insets, toolbarPlacement);
}

/** Horizontal corner clearance beyond the rectangular safe area, without adding header height. */
export function useHeaderInsets() {
  const { width, height } = useWindowDimensions();
  const traits = useAtomValue(windowTraitsAtom);
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  return resolveHeaderInsets({ width, height }, traits, insets);
}

export interface SceneHorizontalInsets {
  readonly paddingLeft: number;
  readonly paddingRight: number;
}

/**
 * Horizontal padding for content in the drawer scene. Side insets appear wherever the system
 * places its status bar, camera, or vertical bar beside the content, as foldables do. A docked
 * sidebar already owns the leading edge, so the scene only pads it when the sidebar is not docked.
 */
export function useSceneHorizontalInsets(): SceneHorizontalInsets {
  const insets = useContext(SafeAreaInsetsContext);
  const { sidebarMode } = useShellLayout();
  return {
    paddingLeft: sidebarMode === 'docked' ? 0 : (insets?.left ?? 0),
    paddingRight: insets?.right ?? 0,
  };
}

/**
 * Horizontal room for content in the drawer scene:
 * - `readable`: extra space on each side that keeps the chat column a readable width.
 * - `foldLeading`: leading space discrete controls skip so they sit on the trailing page, clear
 *   of a hinge, beside the system's own bar. Scrolling content may cross the hinge.
 */
export function useSceneContentInsets(): {
  readonly readable: number;
  readonly foldLeading: number;
} {
  const { width } = useWindowDimensions();
  const layout = useShellLayout();
  const sceneInsets = useSceneHorizontalInsets();
  const sceneLeft = layout.sidebarMode === 'docked' ? layout.sidebarWidth : 0;
  const contentWidth = width - sceneLeft - sceneInsets.paddingLeft - sceneInsets.paddingRight;
  return {
    readable: resolveReadableColumnInset(contentWidth),
    foldLeading: layout.fold
      ? Math.max(0, layout.fold.x + layout.fold.width - sceneLeft - sceneInsets.paddingLeft)
      : 0,
  };
}

export function useSheetMargins(): { readonly marginLeft: number; readonly marginRight: number } {
  const { width } = useWindowDimensions();
  return resolveSheetMargins(width, useShellLayout().fold);
}
