import { atom, useStore } from 'jotai';
import { useLayoutEffect, useRef } from 'react';

export const storeReviewComposerOwnersAtom = atom<ReadonlySet<symbol>>(new Set<symbol>());

export function useStoreReviewComposer(interacting: boolean): void {
  const store = useStore();
  const reviewOwner = useRef(Symbol('composer'));
  useLayoutEffect(() => {
    if (!interacting) {
      return;
    }
    const owner = reviewOwner.current;
    store.set(storeReviewComposerOwnersAtom, (owners: ReadonlySet<symbol>) =>
      new Set(owners).add(owner),
    );
    return () => {
      store.set(storeReviewComposerOwnersAtom, (owners: ReadonlySet<symbol>) => {
        const remaining = new Set(owners);
        remaining.delete(owner);
        return remaining;
      });
    };
  }, [interacting, store]);
}
