import type { Page } from '@playwright/test';

import {
  TABLET_LAYOUT_MIN_WIDTH,
  TABLET_SIDEBAR_WIDTH,
} from '../../apps/mobile/src/shell/boot/appConstants.ts';
import { readRect, readViewportRect, type Rect } from './geometry.ts';
import { selectors } from '../fixtures/selectors.ts';

export { TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_WIDTH };

/**
 * The app runs two different shells, and most layout expectations only make sense relative to one
 * of them:
 *
 * - `overlay` (narrow): the drawer is translated off-screen and slides over the chat.
 * - `pinned` (wide): the drawer is permanently docked and the chat occupies the remaining width.
 *
 * The breakpoint is imported from the app rather than duplicated, so changing the app's contract
 * moves these tests with it instead of silently invalidating them.
 */
export type ShellMode = 'overlay' | 'pinned';

export interface Shell {
  readonly mode: ShellMode;
  readonly viewport: Rect;
  readonly drawer: Rect;
  /** The region the chat occupies: full width when overlaid, inset when the drawer is docked. */
  readonly pane: Rect;
}

export async function readShell(page: Page): Promise<Shell> {
  const viewport = await readViewportRect(page);
  const mode: ShellMode = viewport.width >= TABLET_LAYOUT_MIN_WIDTH ? 'pinned' : 'overlay';
  const [drawer, chrome, composer] = await Promise.all([
    readRect(selectors.drawer(page)),
    readRect(selectors.topChrome(page)),
    readRect(selectors.composer(page)),
  ]);

  const pane: Rect = {
    x: chrome.left,
    y: chrome.top,
    left: chrome.left,
    top: chrome.top,
    right: chrome.right,
    bottom: composer.bottom,
    width: chrome.width,
    height: composer.bottom - chrome.top,
    centerX: chrome.left + chrome.width / 2,
    centerY: chrome.top + (composer.bottom - chrome.top) / 2,
  };

  return { mode, viewport, drawer, pane };
}

export function isPinnedShell(viewport: Rect): boolean {
  return viewport.width >= TABLET_LAYOUT_MIN_WIDTH;
}
