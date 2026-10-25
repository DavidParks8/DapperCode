import { atom } from 'jotai';

import type { WindowTraits } from '@shell/layout/windowLayout';

/** Latest native window traits; `null` until the platform reports them (always on web/Android). */
export const windowTraitsAtom = atom<WindowTraits | null>(null);
