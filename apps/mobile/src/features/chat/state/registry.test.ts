import { requireTestValue } from '@shared/testing/requireTestValue';
import { activityAtom } from './composer';
import { gitCheckoutRepoUrlAtom } from '../../workspace/state/gitCheckout';
import { titleDraftAtom } from './modals';
import { selectedModelIdAtom } from './models';
import { listScreenAtomEntries, resetMainScreenStateAtom, screenRefView } from './registry';
import { runWatchdogNowAtom, selectedChatIdAtom } from './session';
import { sendingAtom } from './turn';
import { workspaceBrowsePathAtom } from '../../workspace/state/workspace';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { createTestStore } from '@shell/state/testing';

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
    // `*Actions.ts` modules are exempt because write-only action atoms hold no state; the next
    // case is what keeps them from smuggling state in.
    const offenders: string[] = [];
    for (const file of readScreenStateFiles()) {
      if (file.name.endsWith('Actions.ts')) {
        continue;
      }
      for (const line of file.source.split('\n')) {
        if (/(?<!screen)\batom[(<]/.test(line) && !line.trim().startsWith('*')) {
          offenders.push(`${file.name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps action modules free of screen state', () => {
    const offenders: string[] = [];
    for (const file of readScreenStateFiles()) {
      if (!file.name.endsWith('Actions.ts') || !file.source.includes('screenAtom(')) {
        continue;
      }
      offenders.push(file.name);
    }
    expect(offenders).toEqual([]);
  });

  it('seeds the run-watchdog clock with the current time', () => {
    // runWatchdogUntil is compared against this value, so a 0 baseline would report every
    // watchdog as still running until the first tick.
    const store = createTestStore();
    // The module-load baseline is already a real timestamp rather than 0.
    expect(store.get(runWatchdogNowAtom)).toBeGreaterThan(0);

    // Every mount resets, and that reset has to produce a current timestamp.
    store.set(runWatchdogNowAtom, 0);
    const beforeReset = Date.now();
    store.set(resetMainScreenStateAtom);
    expect(store.get(runWatchdogNowAtom)).toBeGreaterThanOrEqual(beforeReset);
  });

  it('memoizes every screenRefView live view on the store', () => {
    // screenRefView returns a new object on every call. Consumers list these views in hook
    // dependency arrays, so an unmemoized call site invalidates every memoized callback that
    // reads it on each render, which cascades into an unbounded render loop on MainScreen.
    const offenders: string[] = [];
    for (const file of readLiveViewConsumerFiles()) {
      const normalized = file.source.replace(/\s+/g, ' ');
      const pattern = /(.{0,40})screenRefView\(/g;
      let match = pattern.exec(normalized);
      while (match) {
        if (!/useMemo\( ?\(\) => $/.test(requireTestValue(match[1], 'indexed test value'))) {
          offenders.push(`${file.name}: ${match[0].trim()}`);
        }
        match = pattern.exec(normalized);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps a memoized live view reading the newest atom value', () => {
    const store = createTestStore();
    const view = screenRefView(store, selectedChatIdAtom);
    expect(view.current).toBeNull();
    store.set(selectedChatIdAtom, 'thread-9');
    expect(view.current).toBe('thread-9');
  });

  it('isolates screen state between stores', () => {
    const a = createTestStore();
    const b = createTestStore();
    a.set(selectedChatIdAtom, 'thread-a');
    expect(b.get(selectedChatIdAtom)).toBeNull();
  });
});

function readLiveViewConsumerFiles(): { name: string; source: string }[] {
  const directory = join(__dirname, '..');
  const files: { name: string; source: string }[] = [];
  const readDirectory = (currentDirectory: string) => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'state') {
          readDirectory(entryPath);
        }
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      files.push({ name: entry.name, source: readFileSync(entryPath, 'utf8') });
    }
  };
  readDirectory(directory);
  return files.filter((file) => file.source.includes('screenRefView('));
}

function readScreenStateFiles(): { name: string; source: string }[] {
  return readdirSync(__dirname)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'registry.ts')
    .map((name) => ({ name, source: readFileSync(join(__dirname, name), 'utf8') }));
}
