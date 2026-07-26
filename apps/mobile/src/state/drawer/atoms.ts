import { atom } from 'jotai';

/** True while the drawer layer is mounted/interactive (including mid-gesture). */
export const drawerVisibleAtom = atom(false);

/** True while the drawer layer should intercept touches. */
export const drawerCapturesTouchesAtom = atom(false);

/** True once the drawer has settled in the open position. */
export const drawerOpenAtom = atom(false);

export const tabletSidebarVisibleAtom = atom(true);

export interface DrawerCommands {
  closeDrawer: () => void;
  toggleNavigation: () => void;
}

export const drawerCommandsAtom = atom<DrawerCommands | null>(null);

export const closeDrawerAtom = atom(null, (get): void => {
  get(drawerCommandsAtom)?.closeDrawer();
});
