import { atom, type Atom, type PrimitiveAtom } from 'jotai';
import type { SetStateAction } from 'react';

import type { AppStore } from '../types';

interface ScreenAtomEntry {
  atom: PrimitiveAtom<unknown>;
  createInitialValue: () => unknown;
}

const entries: ScreenAtomEntry[] = [];

/**
 * Creates a MainScreen-scoped primitive atom that is registered for reset.
 *
 * MainScreen state used to be wiped by remounting the screen per bridge profile. Atoms outlive
 * remounts, so every screen atom must be resettable through `resetMainScreenStateAtom`; using this
 * helper instead of `atom()` keeps the registry from drifting.
 *
 * Pass a factory for object and array values. Reset assigns whatever this returns, so sharing one
 * literal across resets would let a single in-place mutation poison the baseline permanently.
 */
export function screenAtom<Value>(initialValue: Exclude<Value, object>): PrimitiveAtom<Value>;
export function screenAtom<Value>(createInitialValue: () => Value): PrimitiveAtom<Value>;
export function screenAtom<Value>(
  initialValue: Value | (() => Value)
): PrimitiveAtom<Value> {
  const createInitialValue = (
    typeof initialValue === 'function' ? initialValue : () => initialValue
  ) as () => Value;
  const created = atom(createInitialValue());
  entries.push({
    atom: created as PrimitiveAtom<unknown>,
    createInitialValue: createInitialValue as () => unknown,
  });
  return created;
}

/** Exposed so tests can assert the registry covers every screen atom. */
export function listScreenAtomEntries(): readonly ScreenAtomEntry[] {
  return entries;
}

export const resetMainScreenStateAtom = atom(null, (get, set): void => {
  for (const entry of entries) {
    set(entry.atom, entry.createInitialValue());
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
