import { Provider } from 'jotai';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { createDefaultAppStateData } from '@shell/state/appState';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { localRuntimeAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createTestStore } from '@shell/state/testing';
import { createFakeSetupRuntime } from './testing';
import { useProfileChoices, type ProfileChoices } from './useProfileChoices';

const MODEL = 'qwen3-1.7b-q4-k-m';

describe('profile choices', () => {
  it('are rebuilt only when the local setup summary changes', () => {
    const data = createDefaultAppStateData();
    data.bridgeProfiles = { activeProfileId: LOCAL_PROFILE_ID, profiles: [] };
    const store = createTestStore({ data });
    store.set(localProfileAvailableAtom, true);
    const fake = createFakeSetupRuntime({
      modelId: MODEL,
      workspaceId: 'w1',
      workspaces: [{ id: 'w1', name: 'demo' }],
      downloadPhase: 'downloading',
    });
    store.set(localRuntimeAtom, fake.runtime);
    const seen: ProfileChoices[] = [];
    function Probe() {
      seen.push(useProfileChoices());
      return null;
    }
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <Provider store={store}>
          <Probe />
        </Provider>,
      );
    });
    const first = seen.at(-1);
    expect(first?.activePresentation?.status).toBe('Downloading model');

    act(() => {
      for (let tick = 0; tick < 40; tick += 1) {
        fake.emit('downloads');
        fake.emit('threads');
      }
    });
    // A Git author changes setup but not how profiles are presented.
    act(() => fake.update({ author: { name: 'Ada', email: 'ada@example.com' } }));
    expect(seen.at(-1)).toBe(first);

    act(() => fake.update({ downloadPhase: 'ready' }));
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)?.activePresentation?.status).toBe('Ready');
    expect(seen.at(-1)?.options(() => undefined)[0]?.description).toBe(
      'Ready · Private offline models',
    );
    act(() => tree?.unmount());
  });
});
