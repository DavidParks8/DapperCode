import { fireEvent, render, screen } from '@testing-library/react-native';
import { Provider, createStore } from 'jotai';

import { router } from 'expo-router';
import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { localRuntimeAtom } from '@shell/state/local/atoms';
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
