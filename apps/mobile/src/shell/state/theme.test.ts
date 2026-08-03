import { defaultStartCwdAtom, rememberThreadSettingsAtom } from '@shell/state/appState/settings';
import { createTestStore } from '@shell/state/testing';
import { systemColorSchemeAtom, themeAtom } from '@shell/state/theme';

describe('themeAtom', () => {
  it('stays identical across settings writes that cannot affect the theme', () => {
    const store = createTestStore();
    const initial = store.get(themeAtom);

    store.set(defaultStartCwdAtom, '/repo');
    store.set(rememberThreadSettingsAtom, 'codex', 'plan');

    expect(store.get(themeAtom)).toBe(initial);
  });

  it('rebuilds when the system color scheme changes', () => {
    const store = createTestStore();
    const initial = store.get(themeAtom);
    expect(initial.mode).toBe('dark');

    store.set(systemColorSchemeAtom, 'light');
    const light = store.get(themeAtom);
    expect(light).not.toBe(initial);
    expect(light.mode).toBe('light');

    store.set(systemColorSchemeAtom, 'light');
    expect(store.get(themeAtom).mode).toBe('light');
  });
});
