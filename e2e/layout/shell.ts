import type { Page } from '@playwright/test';

import { readRect, readViewportRect, type Rect } from './geometry.ts';
import { selectors } from '../fixtures/selectors.ts';

/**
 * Product-level layout expectations, deliberately independent from the implementation constants.
 *
 * Importing the app's values here made the assertions adapt to a breakpoint regression. It also
 * crossed the mobile package's CommonJS boundary, which Node 22 cannot load as named ESM exports.
 * The boundary test below these helpers proves the app still implements these intended values.
 */
export const TABLET_LAYOUT_MIN_WIDTH = 700;
export const TABLET_SIDEBAR_WIDTH = 312;

/**
 * The app runs two different shells, and most layout expectations only make sense relative to one
 * of them:
 *
 * - `overlay` (narrow): the drawer is translated off-screen and slides over the chat.
 * - `pinned` (wide): the drawer is permanently docked and the chat occupies the remaining width.
 *
 * The mode is measured from the rendered pane rather than inferred from the expected breakpoint.
 * That distinction is what lets the breakpoint test detect an implementation regression.
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
  const [drawer, chrome, composer] = await Promise.all([
    readRect(selectors.drawer(page)),
    readRect(selectors.topChrome(page)),
    readRect(selectors.composer(page)),
  ]);
  const mode: ShellMode = chrome.left > viewport.left + 1 ? 'pinned' : 'overlay';

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

/**
 * Asserts the shell the viewport is *intended* to produce.
 *
 * `readShell` measures the rendered pane, while the caller supplies the expected mode. A regression
 * that moves the breakpoint therefore fails instead of simply relabelling the shell.
 */
export async function expectShellMode(page: Page, expected: ShellMode): Promise<Shell> {
  const shell = await readShell(page);
  if (shell.mode !== expected) {
    throw new Error(
      `Expected a ${expected} shell at ${String(Math.round(shell.viewport.width))}px wide, but the ` +
        `app produced a ${shell.mode} shell. The tablet breakpoint ` +
        `(TABLET_LAYOUT_MIN_WIDTH = ${String(TABLET_LAYOUT_MIN_WIDTH)}) has moved across this ` +
        `viewport, so the layout contract these tests describe has changed.`,
    );
  }
  return shell;
}

/**
 * The shell each Playwright project is declared to exercise.
 *
 * Tests skip on this rather than on a measured mode, so the pinned branch cannot disappear behind a
 * skip just because the app started reporting a different shell.
 */
export function expectedShellModeFor(projectName: string): ShellMode {
  switch (projectName) {
    case 'phone':
      return 'overlay';
    case 'tablet':
      return 'pinned';
    default:
      throw new Error(
        `No shell mode is declared for the "${projectName}" project. Add it to ` +
          `expectedShellModeFor in e2e/layout/shell.ts so shell-specific tests know whether to run.`,
      );
  }
}
