import { Provider } from 'jotai';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { localRuntimeAtom } from '@shell/state/local/atoms';
import { createTestStore } from '@shell/state/testing';
import { localSetupState, useLocalSetup } from './localSetup';
import { createFakeSetupRuntime } from './testing';

const MODEL = 'qwen3-1.7b-q4-k-m';
const workspace = { id: 'w1', name: 'demo' };

describe('local setup progress', () => {
  it.each([
    [{ modelId: null }, 'todo', 'todo', 'Needs a model', 'choose-model'],
    [{ downloadPhase: 'not_downloaded' }, 'todo', 'todo', 'Needs a model', 'download-model'],
    [
      { downloadPhase: 'downloading' },
      'in-progress',
      'todo',
      'Downloading model',
      'wait-for-download',
    ],
    [{ downloadPhase: 'ready' }, 'done', 'todo', 'Needs a workspace', 'choose-workspace'],
    [
      { downloadPhase: 'ready', workspaceId: 'w1', workspaces: [workspace] },
      'done',
      'done',
      'Ready',
      null,
    ],
  ] as const)('maps %j to model %s, workspace %s', (patch, model, step, summary, action) => {
    const { runtime } = createFakeSetupRuntime({
      modelId: MODEL,
      workspaceId: null,
      workspaces: [],
      downloadPhase: 'not_downloaded',
      ...patch,
    });
    const state = localSetupState(runtime);
    expect(state).toMatchObject({ model, workspace: step, summary });
    expect(state.readiness.action).toBe(action);
  });

  it('follows the open runtime and is null while the local profile is closed', () => {
    const store = createTestStore();
    const seen: (string | null)[] = [];
    function Probe() {
      const setup = useLocalSetup();
      seen.push(setup?.summary ?? null);
      return <Text>{setup?.summary ?? 'closed'}</Text>;
    }
    const wrap = (node: ReactNode) => <Provider store={store}>{node}</Provider>;
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(wrap(<Probe />));
    });
    expect(seen.at(-1)).toBeNull();

    const fake = createFakeSetupRuntime({
      modelId: MODEL,
      workspaceId: null,
      workspaces: [],
      downloadPhase: 'downloading',
    });
    act(() => store.set(localRuntimeAtom, fake.runtime));
    expect(seen.at(-1)).toBe('Downloading model');
    act(() => fake.update({ downloadPhase: 'ready', workspaceId: 'w1', workspaces: [workspace] }));
    expect(seen.at(-1)).toBe('Ready');
    act(() => store.set(localRuntimeAtom, null));
    expect(seen.at(-1)).toBeNull();
    act(() => tree?.unmount());
  });
});
