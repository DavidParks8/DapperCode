import type { ShellLayout } from '@shell/layout/windowLayout';
import type { SceneHorizontalInsets } from '@shell/layout/useShellLayout';

/** Minimum chat scene width required to host the Live Call Stage side-by-side without crowding. */
export const WIDE_SPLIT_STAGE_MIN_SCENE_WIDTH = 820;
const WIDE_SPLIT_STAGE_MIN_WIDTH = 330;
const WIDE_SPLIT_STAGE_MAX_WIDTH = 400;
const WIDE_SPLIT_STAGE_RATIO = 0.4;

export type PhoneCallStageLayout =
  | { readonly mode: 'sheet' }
  | {
      readonly mode: 'split-pane';
      /** Width allocated to the trailing Live Call Stage pane (inside `chat-body`). */
      readonly paneWidth: number;
      /** Gap between the leading chat pane and trailing call stage (hinge width in Book pose). */
      readonly dividerWidth: number;
      /** True when the split follows a physical pane-splitting hinge (iPhone Duo Book pose). */
      readonly acrossFold: boolean;
    };

/**
 * Chooses how the Live Call Stage is hosted for the current device geometry:
 * - **Book pose** (`layout.fold !== null`): trailing page across the hinge, keeping chat scrollable
 *   on the leading page and leaving the hinge clear.
 * - **Open wide pose** (`sceneWidth >= 820`, no tabletop fold): trailing split pane beside the chat.
 * - **Phones, Closed Duo, Laptop Duo**: `AppSheet` modal overlay so compact or short upper displays
 *   keep their full width for the conversation.
 */
export function resolvePhoneCallStageLayout(options: {
  windowWidth: number;
  layout: ShellLayout;
  sceneInsets: SceneHorizontalInsets;
}): PhoneCallStageLayout {
  const { windowWidth, layout, sceneInsets } = options;
  if (layout.tabletopFold !== null) {
    return { mode: 'sheet' };
  }

  const sidebarOffset = layout.sidebarMode === 'docked' ? layout.sidebarWidth : 0;
  const sceneWidth = Math.max(
    0,
    windowWidth - sidebarOffset - sceneInsets.paddingLeft - sceneInsets.paddingRight,
  );

  if (layout.fold !== null) {
    const leadingWidth = Math.max(0, layout.fold.x - sidebarOffset - sceneInsets.paddingLeft);
    const trailingEdge = layout.fold.x + layout.fold.width;
    const trailingWidth = Math.max(0, windowWidth - trailingEdge - sceneInsets.paddingRight);
    if (leadingWidth >= 200 && trailingWidth >= 240) {
      return {
        mode: 'split-pane',
        paneWidth: trailingWidth,
        dividerWidth: layout.fold.width,
        acrossFold: true,
      };
    }
    return { mode: 'sheet' };
  }

  if (sceneWidth >= WIDE_SPLIT_STAGE_MIN_SCENE_WIDTH) {
    const paneWidth = Math.min(
      WIDE_SPLIT_STAGE_MAX_WIDTH,
      Math.max(WIDE_SPLIT_STAGE_MIN_WIDTH, Math.floor(sceneWidth * WIDE_SPLIT_STAGE_RATIO)),
    );
    return {
      mode: 'split-pane',
      paneWidth,
      dividerWidth: 1,
      acrossFold: false,
    };
  }

  return { mode: 'sheet' };
}
