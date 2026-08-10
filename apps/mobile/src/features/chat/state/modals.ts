import type { MessageTokenUsage } from '@bridge/types/types';

import { screenAtom } from './registry';

/** Where the anchoring info button sits in window coordinates. */
export interface ResponseUsageAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResponseUsageOverlay {
  /** Identifies the owning action row so its own info button toggles the panel closed. */
  id: string;
  /** Null until the anchoring button reports its window position, which takes a frame. */
  anchor: ResponseUsageAnchor | null;
  usage: MessageTokenUsage;
}

export const titleModalVisibleAtom = screenAtom(false);

export const titleDraftAtom = screenAtom('');

export const titleSavingAtom = screenAtom(false);

export const agentThreadMenuVisibleAtom = screenAtom(false);

export const modelModalVisibleAtom = screenAtom(false);

export const agentModalVisibleAtom = screenAtom(false);

export const collaborationModeMenuVisibleAtom = screenAtom(false);

export const effortModalVisibleAtom = screenAtom(false);

export const effortPickerModelIdAtom = screenAtom<string | null>(null);

/**
 * The response usage panel currently floating over the screen, if any.
 *
 * The panel is anchored to an info button buried in a transcript row, but it has to overlay the
 * header and composer and swallow taps anywhere on the screen, so it is rendered by a screen-level
 * host instead of by the row. Holding at most one entry also keeps a second tap elsewhere from
 * leaving two panels open.
 */
export const responseUsageOverlayAtom = screenAtom<ResponseUsageOverlay | null>(null);
