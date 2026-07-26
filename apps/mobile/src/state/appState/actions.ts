import { atom, type Getter } from 'jotai';

import type { AppStateAction, AppStateData } from '../../appState';
import { appStoreRefAtom, requireAppStore } from './atoms';
import {
  getAppStateCoordinator,
  type AppStatePersistenceCoordinator,
} from './persistenceCoordinator';

function coordinatorFor(get: Getter): AppStatePersistenceCoordinator {
  return getAppStateCoordinator(requireAppStore(get(appStoreRefAtom)));
}

export const initializeAppStateAtom = atom(null, (get): Promise<void> =>
  coordinatorFor(get).initialize(),
);

export const dispatchAppStateAtom = atom(null, (get, set, action: AppStateAction): void => {
  coordinatorFor(get).dispatch(action);
});

export const dispatchDurableAppStateAtom = atom(
  null,
  (get, set, action: AppStateAction): Promise<AppStateData> =>
    coordinatorFor(get).dispatchDurable(action),
);

export const retryPersistenceAtom = atom(null, (get): Promise<void> =>
  coordinatorFor(get).retryPersistence(),
);

export const flushPersistenceAtom = atom(null, (get): Promise<void> =>
  coordinatorFor(get).flushPersistence(),
);
