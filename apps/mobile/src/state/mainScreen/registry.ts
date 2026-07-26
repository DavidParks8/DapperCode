import { atom, type PrimitiveAtom, type Setter } from 'jotai';

const resetters: Array<(set: Setter) => void> = [];

/**
 * Creates a MainScreen-scoped primitive atom that is registered for reset.
 *
 * MainScreen state used to be wiped by remounting the screen per bridge profile. Atoms outlive
 * remounts, so every screen atom must be resettable through `resetMainScreenStateAtom`; using this
 * helper instead of `atom()` keeps the registry from drifting.
 */
export function screenAtom<Value>(initialValue: Value): PrimitiveAtom<Value> {
  const created = atom(initialValue);
  resetters.push((set) => set(created, initialValue));
  return created;
}

export const resetMainScreenStateAtom = atom(null, (get, set): void => {
  for (const reset of resetters) {
    reset(set);
  }
});
