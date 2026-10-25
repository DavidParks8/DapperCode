import { atom, useAtomValue } from 'jotai';

export interface DrawerCommands {
  closeDrawer: () => void;
  toggleNavigation?: () => void;
  /** Accessibility label for the control that runs `toggleNavigation`. */
  navigationLabel?: string;
}

export const OPEN_NAVIGATION_LABEL = 'Open navigation drawer';

export const drawerCommandsAtom = atom<DrawerCommands | null>(null);

export const closeDrawerAtom = atom(null, (get): void => {
  get(drawerCommandsAtom)?.closeDrawer();
});

export function useNavigationToggleLabel(): string {
  return useAtomValue(drawerCommandsAtom)?.navigationLabel ?? OPEN_NAVIGATION_LABEL;
}
