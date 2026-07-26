import { atom, type Atom, type PrimitiveAtom, type Setter } from 'jotai';
import type { SetStateAction } from 'react';

import type { AppStore } from '../types';

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

/**
 * Binds a screen atom to a store so non-React helpers (the WS event processors and command
 * executors) can update screen state without hooks.
 */
export function screenSetter<Value>(
  store: AppStore,
  target: PrimitiveAtom<Value>
): (update: SetStateAction<Value>) => void {
  return (update) => store.set(target, update);
}

/**
 * A read-only `{ current }` view over an atom.
 *
 * Several modules used to mirror state into a ref so callbacks could read the newest value without
 * re-subscribing. Jotai store writes are synchronously visible, so a live read is both simpler and
 * strictly fresher than the mirrored ref, while keeping the `.current` call sites unchanged.
 */
export function screenRefView<Value>(
  store: AppStore,
  source: Atom<Value>
): { readonly current: Value } {
  return {
    get current(): Value {
      return store.get(source);
    },
  };
}
