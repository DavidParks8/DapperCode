import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Provider, createStore } from 'jotai';

import { router } from 'expo-router';
import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { localRuntimeAtom } from '@shell/state/local/atoms';
import type { LocalSkillListing } from '../on-device/runtime/skills';
import { LocalProfileSection } from './LocalProfileSection';
import { FakeSettingsRuntime } from './local/testing';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

beforeEach(() => resetRouterMock());

test('On this iPhone settings open the Models and Git & GitHub pages and summarize their state', () => {
  const runtime = new FakeSettingsRuntime();
  runtime.setSession({ phase: 'ready', modelId: 'qwen3-1.7b-q4-k-m', contextTokens: 8192 });
  runtime.setPreferences({
    account: {
      providerId: 'github',
      host: 'github.com',
      id: '1',
      login: 'ada',
      credentialRef: 'r',
    },
  });
  const store = createStore();
  store.set(localRuntimeAtom, runtime.asRuntime());
  render(
    <Provider store={store}>
      <LocalProfileSection />
    </Provider>,
  );

  fireEvent.press(screen.getByLabelText('Models, Qwen3 1.7B Q4_K_M'));
  expect(router.push).toHaveBeenLastCalledWith({
    pathname: '/profiles/[profileId]/settings/models',
    params: { profileId: 'on-device' },
  });
  fireEvent.press(screen.getByLabelText('Git & GitHub, ada'));
  expect(router.push).toHaveBeenLastCalledWith({
    pathname: '/profiles/[profileId]/settings/github',
    params: { profileId: 'on-device' },
  });
  expect(router.push).not.toHaveBeenCalledWith('/on-device/models');
  expect(router.push).not.toHaveBeenCalledWith('/on-device/account');
});

/** The summary counts only `enabled`; the rest of the listing entry is irrelevant here. */
function skillEntry(name: string, enabled: boolean): LocalSkillListing['skills'][number] {
  return { name, enabled } as LocalSkillListing['skills'][number];
}

function renderSection(runtime: FakeSettingsRuntime) {
  const store = createStore();
  store.set(localRuntimeAtom, runtime.asRuntime());
  render(
    <Provider store={store}>
      <LocalProfileSection />
    </Provider>,
  );
}

test('the Skills row counts enabled skills in the new-chat workspace and opens the Skills page', async () => {
  const runtime = new FakeSettingsRuntime();
  runtime.workspaceList = [
    { id: 'ws-one', name: 'App', isRepository: true },
    { id: 'ws-two', name: 'Skills', isRepository: true },
  ];
  runtime.setPreferences({ workspaceId: 'ws-two' });
  runtime.skillListing = {
    skills: [skillEntry('review', true), skillEntry('plan', false), skillEntry('notes', true)],
    diagnostics: [],
  };
  renderSection(runtime);

  fireEvent.press(await screen.findByLabelText('Skills, 2 enabled'));
  expect(runtime.skills.list).toHaveBeenLastCalledWith('ws-two');
  expect(router.push).toHaveBeenLastCalledWith({
    pathname: '/profiles/[profileId]/settings/skills',
    params: { profileId: 'on-device' },
  });

  // A skills change announced by the runtime refreshes the summary.
  runtime.skillListing = {
    skills: runtime.skillListing.skills.map((skill) => ({ ...skill, enabled: true })),
    diagnostics: [],
  };
  act(() => runtime.emit('skills'));
  expect(await screen.findByLabelText('Skills, 3 enabled')).toBeTruthy();
});

test('the Skills row says None without workspaces or skills', async () => {
  const runtime = new FakeSettingsRuntime();
  renderSection(runtime);
  expect(screen.getByLabelText('Skills, None')).toBeTruthy();
  expect(runtime.skills.list).not.toHaveBeenCalled();

  act(() => {
    runtime.workspaceList = [{ id: 'ws-one', name: 'App', isRepository: true }];
    runtime.emit('workspaces');
  });
  expect(await screen.findByLabelText('Skills, None')).toBeTruthy();
  expect(runtime.skills.list).toHaveBeenCalledWith('ws-one');
});

test('the Skills row says Off when every skill is turned off', async () => {
  const runtime = new FakeSettingsRuntime();
  runtime.workspaceList = [{ id: 'ws-one', name: 'App', isRepository: true }];
  runtime.skillListing = { skills: [skillEntry('review', true)], diagnostics: [] };
  runtime.setPreferences({ skillsEnabled: false });
  renderSection(runtime);
  expect(await screen.findByLabelText('Skills, Off')).toBeTruthy();

  act(() => runtime.setPreferences({ skillsEnabled: true }));
  expect(await screen.findByLabelText('Skills, 1 enabled')).toBeTruthy();
});
