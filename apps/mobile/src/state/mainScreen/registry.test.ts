import { activityAtom } from './composer';
import { gitCheckoutRepoUrlAtom } from './gitCheckout';
import { titleDraftAtom } from './modals';
import { selectedModelIdAtom } from './models';
import { listScreenAtomEntries, resetMainScreenStateAtom } from './registry';
import { selectedChatIdAtom } from './session';
import { sendingAtom } from './turn';
import { workspaceBrowsePathAtom } from './workspace';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { createTestStore } from '../testing';

// Importing every screen atom module above is what populates the registry.
describe('MainScreen atom registry', () => {
  it('clears every domain', () => {
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

  it('registers a meaningful number of atoms', () => {
    expect(listScreenAtomEntries().length).toBeGreaterThan(60);
  });

  it('never reuses one mutable baseline across resets', () => {
    // A shared object literal would let a single in-place mutation poison every later reset,
    // including in other stores, so each reset must produce a fresh value.
    for (const entry of listScreenAtomEntries()) {
      const first = entry.createInitialValue();
      if (first === null || typeof first !== 'object') {
        continue;
      }
      expect(entry.createInitialValue()).not.toBe(first);
      expect(entry.createInitialValue()).toEqual(first);
    }
  });

  it('declares every screen atom through screenAtom', () => {
    // A bare atom() here would never be reset, so its value would leak into the next bridge
    // profile. Scanning the sources is what stops the registry from silently drifting.
    const directory = __dirname;
    const offenders: string[] = [];
    for (const file of readdirSync(directory)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'registry.ts') {
        continue;
      }
      const source = readFileSync(join(directory, file), 'utf8');
      for (const line of source.split('\n')) {
        if (/(?<!screen)\batom[(<]/.test(line) && !line.trim().startsWith('*')) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('isolates screen state between stores', () => {
    const a = createTestStore();
    const b = createTestStore();
    a.set(selectedChatIdAtom, 'thread-a');
    expect(b.get(selectedChatIdAtom)).toBeNull();
  });
});
