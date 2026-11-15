import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Provider, createStore } from 'jotai';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Alert, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { OnDeviceRuntimeScope } from '../../on-device/runtime/OnDeviceProvider';
import { LocalGitAccountScreen } from './LocalGitAccountScreen';
import { FakeSettingsRuntime } from './testing';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const authorization = {
  userCode: 'WDJB-MJHT',
  verificationUrl: 'https://github.com/login/device',
  expiresAt: Date.now() + 900_000,
};

function wrap(
  runtime: FakeSettingsRuntime,
  store: ReturnType<typeof createStore>,
  children: ReactNode,
) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <Provider store={store}>
        <OnDeviceRuntimeScope runtime={runtime.asRuntime()}>{children}</OnDeviceRuntimeScope>
      </Provider>
    </SafeAreaProvider>
  );
}

let openURL: jest.SpyInstance;

beforeEach(() => {
  resetRouterMock();
  jest.mocked(Clipboard.setStringAsync).mockClear();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

afterEach(() => openURL.mockRestore());

async function startSignIn(runtime: FakeSettingsRuntime) {
  await fireEvent.press(screen.getByTestId('settings-local-github-sign-in'));
  await act(async () => {
    await runtime.pendingSignIn?.present(authorization);
  });
}

describe('Git & GitHub settings', () => {
  it('shows and copies the device code, and opens GitHub only when asked', async () => {
    const runtime = new FakeSettingsRuntime();
    await render(wrap(runtime, createStore(), <LocalGitAccountScreen />));
    expect(screen.getAllByText('Git & GitHub').length).toBeGreaterThan(0);
    await startSignIn(runtime);

    expect(screen.getByText('WDJB-MJHT')).toBeTruthy();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('WDJB-MJHT');
    expect(screen.getByText('Copied to the clipboard.')).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('settings-local-github-open'));
    expect(openURL).toHaveBeenCalledWith('https://github.com/login/device');

    await act(async () => {
      await runtime.completeSignIn({
        providerId: 'github',
        host: 'github.com',
        id: '42',
        login: 'octocat',
        credentialRef: 'ref',
      });
    });
    expect(screen.getByLabelText('Signed in as, octocat')).toBeTruthy();
    expect(screen.queryByText('WDJB-MJHT')).toBeNull();
  });

  it('keeps an in-progress sign-in when the page is left and shows the same code on return', async () => {
    const runtime = new FakeSettingsRuntime();
    const store = createStore();
    const first = await render(wrap(runtime, store, <LocalGitAccountScreen />));
    await startSignIn(runtime);
    await first.unmount();
    expect(runtime.authentication.cancelSignIn).not.toHaveBeenCalled();

    await render(wrap(runtime, store, <LocalGitAccountScreen />));
    expect(screen.getByText('WDJB-MJHT')).toBeTruthy();
    expect(runtime.signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-local-github-cancel'));
    });
    expect(runtime.authentication.cancelSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('WDJB-MJHT')).toBeNull();
    expect(screen.getByTestId('settings-local-github-sign-in')).toBeTruthy();
    expect(screen.queryByText(/cancelled/)).toBeNull();
  });

  it('announces a completed sign-in once, never on later visits or after signing out', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    announce.mockClear();
    const runtime = new FakeSettingsRuntime();
    const store = createStore();
    const first = await render(wrap(runtime, store, <LocalGitAccountScreen />));
    await startSignIn(runtime);
    await act(async () => {
      await runtime.completeSignIn({
        providerId: 'github',
        host: 'github.com',
        id: '42',
        login: 'octocat',
        credentialRef: 'ref',
      });
    });
    const signedIn = (call: unknown[]) => String(call[0]).startsWith('Signed in to GitHub');
    expect(announce.mock.calls.filter(signedIn)).toEqual([['Signed in to GitHub as octocat.']]);
    await first.unmount();

    announce.mockClear();
    const revisit = await render(wrap(runtime, store, <LocalGitAccountScreen />));
    expect(announce.mock.calls.filter(signedIn)).toHaveLength(0);
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-local-github-sign-out'));
    });
    await revisit.unmount();

    await render(wrap(runtime, store, <LocalGitAccountScreen />));
    expect(screen.getByTestId('settings-local-github-sign-in')).toBeTruthy();
    expect(announce.mock.calls.filter(signedIn)).toHaveLength(0);
    announce.mockRestore();
  });

  it('hides build configuration details when sign-in is unavailable', async () => {
    const runtime = new FakeSettingsRuntime();
    runtime.configured = false;
    await render(wrap(runtime, createStore(), <LocalGitAccountScreen />));
    expect(screen.getByLabelText('GitHub sign-in, Unavailable')).toBeTruthy();
    expect(screen.queryByText(/EXPO_PUBLIC|client id|OAuth|rebuild/i)).toBeNull();
    expect(screen.queryByTestId('settings-local-github-sign-in')).toBeNull();

    await act(() =>
      runtime.setPreferences({
        account: {
          providerId: 'github',
          host: 'github.com',
          id: '1',
          login: 'ada',
          credentialRef: 'r',
        },
      }),
    );
    expect(screen.getByTestId('settings-local-github-sign-out')).toBeTruthy();
  });

  it('signs out in place without a confirmation dialog', async () => {
    const runtime = new FakeSettingsRuntime();
    const alert = jest.spyOn(Alert, 'alert');
    runtime.setPreferences({
      account: {
        providerId: 'github',
        host: 'github.com',
        id: '1',
        login: 'ada',
        credentialRef: 'r',
      },
    });
    await render(wrap(runtime, createStore(), <LocalGitAccountScreen />));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-local-github-sign-out'));
    });
    expect(runtime.signOut).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-local-github-sign-in')).toBeTruthy();
    alert.mockRestore();
  });

  it('validates the commit author, saves only changes, and confirms the save', async () => {
    const runtime = new FakeSettingsRuntime();
    runtime.setPreferences({ author: { name: 'Ada', email: 'ada@example.com' } });
    await render(wrap(runtime, createStore(), <LocalGitAccountScreen />));
    const name = screen.getByTestId('settings-local-author-name');
    const email = screen.getByTestId('settings-local-author-email');
    expect(name.props['textContentType']).toBe('name');
    expect(name.props['autoComplete']).toBe('name');
    expect(email.props['textContentType']).toBe('emailAddress');
    expect(email.props['autoComplete']).toBe('email');
    expect(email.props['keyboardType']).toBe('email-address');
    const save = () => screen.getByTestId('settings-local-author-save');
    expect(save().props['accessibilityState']).toMatchObject({ disabled: true });

    await fireEvent.changeText(email, 'ada-at-example');
    expect(screen.getByText('Enter an email address like name@example.com.')).toBeTruthy();
    expect(save().props['accessibilityState']).toMatchObject({ disabled: true });

    await fireEvent.changeText(email, ' ada@lovelace.dev ');
    expect(save().props['accessibilityState']).toMatchObject({ disabled: false });
    await act(async () => {
      await fireEvent.press(save());
    });
    expect(runtime.saveAuthor).toHaveBeenCalledWith({ name: 'Ada', email: ' ada@lovelace.dev ' });
    expect(screen.getByText('Commit author saved.')).toBeTruthy();
    expect(screen.getByLabelText('Saved')).toBeTruthy();
    expect(save().props['accessibilityState']).toMatchObject({ disabled: true });
  });

  it('fills an untouched author from GitHub sign-in but never overwrites edits', async () => {
    const runtime = new FakeSettingsRuntime();
    await render(wrap(runtime, createStore(), <LocalGitAccountScreen />));
    await act(() =>
      runtime.setPreferences({
        author: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
      }),
    );
    expect(screen.getByTestId('settings-local-author-name').props['value']).toBe('octocat');

    await fireEvent.changeText(screen.getByTestId('settings-local-author-name'), 'Mona');
    await act(() => runtime.setPreferences({ author: { name: 'other', email: 'o@example.com' } }));
    expect(screen.getByTestId('settings-local-author-name').props['value']).toBe('Mona');
  });
});
