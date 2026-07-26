import { activityAtom } from './composer';
import { gitCheckoutRepoUrlAtom } from './gitCheckout';
import { titleDraftAtom } from './modals';
import { selectedModelIdAtom } from './models';
import { resetMainScreenStateAtom } from './registry';
import { selectedChatIdAtom } from './session';
import { sendingAtom } from './turn';
import { workspaceBrowsePathAtom } from './workspace';
import { createTestStore } from '../testing';

it('clears every MainScreen domain', () => {
  const store = createTestStore();
  store.set(gitCheckoutRepoUrlAtom, 'https://example.test/repo.git');
  store.set(titleDraftAtom, 'Renamed');
  store.set(selectedModelIdAtom, 'model-1');
  store.set(selectedChatIdAtom, 'thread-1');
  store.set(sendingAtom, true);
  store.set(workspaceBrowsePathAtom, '/repo');
  store.set(activityAtom, { tone: 'running', title: 'Working' });

  store.set(resetMainScreenStateAtom);

  expect(store.get(gitCheckoutRepoUrlAtom)).toBe('');
  expect(store.get(titleDraftAtom)).toBe('');
  expect(store.get(selectedModelIdAtom)).toBeNull();
  expect(store.get(selectedChatIdAtom)).toBeNull();
  expect(store.get(sendingAtom)).toBe(false);
  expect(store.get(workspaceBrowsePathAtom)).toBeNull();
  expect(store.get(activityAtom)).toEqual({ tone: 'idle', title: 'Ready' });
});
