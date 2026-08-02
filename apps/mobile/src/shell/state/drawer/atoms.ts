import { atom } from 'jotai';

export interface DrawerCommands {
  closeDrawer: () => void;
  toggleNavigation?: () => void;
}

export const drawerCommandsAtom = atom<DrawerCommands | null>(null);

export const closeDrawerAtom = atom(null, (get): void => {
  get(drawerCommandsAtom)?.closeDrawer();
});
