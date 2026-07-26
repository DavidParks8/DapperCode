import { appearancePreferenceAtom, defaultStartCwdAtom, rememberThreadSettingsAtom } from './appState/settings';
import { createTestStore } from './testing';
import { systemColorSchemeAtom, themeAtom } from './theme';

describe('themeAtom', () => {
  it('stays identical across settings writes that cannot affect the theme', () => {
    const store = createTestStore();
    const initial = store.get(themeAtom);

    store.set(defaultStartCwdAtom, '/repo');
    store.set(rememberThreadSettingsAtom, 'codex', 'plan');

    expect(store.get(themeAtom)).toBe(initial);
  });

  it('rebuilds only when the resolved mode actually changes', () => {
    const store = createTestStore();
    const initial = store.get(themeAtom);
    expect(initial.mode).toBe('dark');

    store.set(appearancePreferenceAtom, 'dark');
    expect(store.get(themeAtom)).toBe(initial);

    store.set(appearancePreferenceAtom, 'light');
    const light = store.get(themeAtom);
    expect(light).not.toBe(initial);
    expect(light.mode).toBe('light');

    store.set(appearancePreferenceAtom, 'system');
    store.set(systemColorSchemeAtom, 'light');
    expect(store.get(themeAtom).mode).toBe('light');
  });
});
