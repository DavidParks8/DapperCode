import { atom, useStore } from 'jotai';
import { useLayoutEffect, useRef } from 'react';

export const keyboardFocusBlockersAtom = atom<ReadonlySet<symbol>>(new Set<symbol>());

/** A covering surface owns focus until it has finished dismissing. */
export function useKeyboardFocusBlocker(active: boolean): void {
  const store = useStore();
  const ownerRef = useRef(Symbol('keyboard-focus'));
  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const owner = ownerRef.current;
    store.set(keyboardFocusBlockersAtom, (owners) => new Set(owners).add(owner));
    return () => {
      store.set(keyboardFocusBlockersAtom, (owners) => {
        const remaining = new Set(owners);
        remaining.delete(owner);
        return remaining;
      });
    };
  }, [active, store]);
}
