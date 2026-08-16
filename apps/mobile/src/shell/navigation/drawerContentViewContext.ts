import { createContext, useContext } from 'react';

import type { DrawerContentAtoms } from '@shell/state/drawer/contentAtoms';

export const DrawerContentAtomsContext = createContext<DrawerContentAtoms | null>(null);

export function useDrawerContentAtoms(): DrawerContentAtoms {
  const atoms = useContext(DrawerContentAtomsContext);
  if (!atoms) {
    throw new Error('DrawerContentView requires DrawerContentAtomsContext');
  }
  return atoms;
}
