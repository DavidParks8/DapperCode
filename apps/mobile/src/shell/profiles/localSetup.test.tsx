import { Provider } from 'jotai';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { localDefaultStartCwdAtom, localSetupCompletedAtom } from '@shell/state/appState/settings';
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

  // The first download starts from the model library without selecting a model; the server still
  // starts chats with any downloaded model, so setup must follow that download.
  it.each([
    ['queued', 'in-progress', 'Downloading model', 'wait-for-download'],
    ['downloading', 'in-progress', 'Downloading model', 'wait-for-download'],
    ['verifying', 'in-progress', 'Downloading model', 'wait-for-download'],
    ['ready', 'done', 'Needs a workspace', 'choose-workspace'],
  ] as const)(
    'reports an unselected first download that is %s as %s',
    (phase, model, summary, action) => {
      const { runtime } = createFakeSetupRuntime({
        modelId: null,
        workspaceId: null,
        workspaces: [],
        downloadPhase: 'not_downloaded',
        downloadPhases: { [MODEL]: phase },
      });
      const state = localSetupState(runtime);
      expect(state).toMatchObject({ model, workspace: 'todo', summary });
      expect(state.readiness.action).toBe(action);
    },
  );

  it('recommends a Git author and tracks the first chat without changing readiness', () => {
    const ready = {
      modelId: MODEL,
      workspaceId: 'w1',
      workspaces: [workspace],
      downloadPhase: 'ready',
    };
    const { runtime, update } = createFakeSetupRuntime(ready);
    expect(localSetupState(runtime)).toMatchObject({
      author: 'recommended',
      chatStarted: false,
      summary: 'Ready',
    });
    expect(localSetupState(runtime).readiness.canStart).toBe(true);

    update({ author: { name: 'Ada', email: 'ada@example.com' }, threadMessages: [0] });
    expect(localSetupState(runtime)).toMatchObject({ author: 'done', chatStarted: false });
    update({ threadMessages: [0, 1] });
    expect(localSetupState(runtime).chatStarted).toBe(true);
  });

  it('is ready with an unselected downloaded model, as the server would start the chat', () => {
    const { runtime } = createFakeSetupRuntime({
      modelId: null,
      workspaceId: 'w1',
      workspaces: [workspace],
      downloadPhase: 'not_downloaded',
      downloadPhases: { [MODEL]: 'ready' },
    });
    expect(localSetupState(runtime)).toMatchObject({ model: 'done', summary: 'Ready' });
    expect(localSetupState(runtime).readiness.canStart).toBe(true);
  });

  it('falls back from a selected model that is not downloaded to a downloaded one', () => {
    const { runtime } = createFakeSetupRuntime({
      modelId: 'gemma-4-e2b-q4-0',
      workspaceId: 'w1',
      workspaces: [workspace],
      downloadPhase: 'not_downloaded',
      downloadPhases: { [MODEL]: 'ready' },
    });
    expect(localSetupState(runtime).summary).toBe('Ready');
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

  it('follows the remembered new-chat workspace rather than an unrelated runtime preference', () => {
    const store = createTestStore();
    const fake = createFakeSetupRuntime({
      modelId: MODEL,
      workspaceId: 'w1',
      workspaces: [workspace, { id: 'w2', name: 'other' }],
      downloadPhase: 'ready',
    });
    store.set(localRuntimeAtom, fake.runtime);
    store.set(localDefaultStartCwdAtom, '/On this iPhone/other');
    let setup: ReturnType<typeof useLocalSetup> = null;
    function Probe() {
      setup = useLocalSetup();
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
    expect(setup).toMatchObject({ workspace: 'done', summary: 'Ready' });
    act(() => store.set(localDefaultStartCwdAtom, '/On this iPhone/deleted'));
    expect(setup).toMatchObject({ workspace: 'todo', summary: 'Needs a workspace' });
    act(() => store.set(localDefaultStartCwdAtom, '/On this iPhone/other'));
    expect(setup).toMatchObject({ workspace: 'done', summary: 'Ready' });
    act(() => fake.update({ workspaceId: null, workspaces: [{ id: 'w2', name: 'other' }] }));
    expect(setup).toMatchObject({ workspace: 'done', summary: 'Ready' });
    act(() => tree?.unmount());
  });

  describe('while the runtime streams and downloads', () => {
    function renderProbe(store: ReturnType<typeof createTestStore>) {
      const seen: ReturnType<typeof useLocalSetup>[] = [];
      function Probe() {
        const setup = useLocalSetup();
        seen.push(setup);
        return <Text>{setup?.summary ?? 'closed'}</Text>;
      }
      let tree: ReactTestRenderer | undefined;
      act(() => {
        tree = renderer.create(
          <Provider store={store}>
            <Probe />
          </Provider>,
        );
      });
      return { seen, unmount: () => act(() => tree?.unmount()) };
    }

    const watchedSlices = (subscribe: jest.SpyInstance) =>
      (subscribe.mock.calls.at(-1) as [unknown, readonly string[]])[1];

    it('keeps one setup object until a visible field changes, then stops watching chats', () => {
      const store = createTestStore();
      const fake = createFakeSetupRuntime({
        modelId: MODEL,
        workspaceId: null,
        workspaces: [],
        downloadPhase: 'downloading',
        threadMessages: [0],
      });
      const list = jest.spyOn(fake.runtime.threads, 'list');
      const subscribe = jest.spyOn(fake.runtime, 'subscribe');
      store.set(localRuntimeAtom, fake.runtime);
      const { seen, unmount } = renderProbe(store);
      const first = seen.at(-1);
      const renders = seen.length;
      expect(first).toMatchObject({ model: 'in-progress', chatStarted: false });
      expect(watchedSlices(subscribe)).toContain('threads');

      // Download progress ticks never scan chats and, with nothing visible changing, never render.
      const scans = list.mock.calls.length;
      act(() => {
        for (let tick = 0; tick < 40; tick += 1) {
          fake.emit('downloads');
        }
      });
      expect(list).toHaveBeenCalledTimes(scans);
      act(() => {
        for (let tick = 0; tick < 40; tick += 1) {
          fake.emit('threads');
        }
      });
      expect(seen).toHaveLength(renders);
      expect(seen.at(-1)).toBe(first);

      act(() => fake.update({ downloadPhase: 'ready' }));
      const downloaded = seen.at(-1);
      expect(downloaded).not.toBe(first);
      expect(downloaded).toMatchObject({ model: 'done', summary: 'Needs a workspace' });

      act(() => fake.update({ workspaceId: 'w1', workspaces: [workspace] }));
      expect(seen.at(-1)).toMatchObject({
        workspace: 'done',
        summary: 'Ready',
        chatStarted: false,
      });

      act(() => fake.update({ threadMessages: [0, 1] }));
      const started = seen.at(-1);
      expect(started).toMatchObject({ summary: 'Ready', chatStarted: true });
      expect(watchedSlices(subscribe)).not.toContain('threads');

      // Once the first chat started, token streams neither scan chats nor render.
      const startedRenders = seen.length;
      const startedScans = list.mock.calls.length;
      act(() => {
        for (let tick = 0; tick < 40; tick += 1) {
          fake.emit('threads');
          fake.emit('downloads');
        }
      });
      expect(list).toHaveBeenCalledTimes(startedScans);
      expect(seen).toHaveLength(startedRenders);
      expect(seen.at(-1)).toBe(started);
      unmount();
    });

    it('never watches or scans chats once setup is completed', () => {
      const store = createTestStore();
      store.set(localSetupCompletedAtom, true);
      const fake = createFakeSetupRuntime({
        modelId: MODEL,
        workspaceId: null,
        workspaces: [],
        downloadPhase: 'downloading',
      });
      const list = jest.spyOn(fake.runtime.threads, 'list');
      const subscribe = jest.spyOn(fake.runtime, 'subscribe');
      store.set(localRuntimeAtom, fake.runtime);
      const { seen, unmount } = renderProbe(store);
      expect(seen.at(-1)).toMatchObject({ summary: 'Downloading model', chatStarted: true });
      expect(watchedSlices(subscribe)).not.toContain('threads');

      act(() =>
        fake.update({ downloadPhase: 'ready', workspaceId: 'w1', workspaces: [workspace] }),
      );
      expect(seen.at(-1)).toMatchObject({ summary: 'Ready', chatStarted: true });
      expect(list).not.toHaveBeenCalled();
      unmount();
    });
  });
});
