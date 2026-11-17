import type * as React from 'react';
import type * as ReactNative from 'react-native';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(
    ({ name }: { name: string }) =>
      jest
        .requireActual<typeof React>('react')
        .createElement(
          jest.requireActual<typeof ReactNative>('react-native').Text,
          { testID: 'mock-ionicon', accessibilityLabel: name },
          name,
        ),
    { glyphMap: {} },
  ),
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Provider } from 'jotai';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createDefaultAppStateData } from '@shell/state/appState';
import { localSetupCompletedAtom, localSetupDismissedAtom } from '@shell/state/appState/settings';
import { localProfileAvailableAtom, bridgeConnectedAtom } from '@shell/state/bridge/atoms';
import { localRuntimeAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createTestStore } from '@shell/state/testing';
import { LOCAL_SETUP_DESTINATIONS, useRecordLocalSetupCompletion } from './localSetup';
import {
  DrawerProfileRow,
  LocalSetupGuide,
  NewChatRunTarget,
  PROFILE_SWITCHER_TITLE,
} from './ProfileSwitcher';
import { createFakeSetupRuntime, type FakeSetupRuntimeState } from './testing';

const MODEL = 'qwen3-1.7b-q4-k-m';
const ROW_STYLES = {
  row: { padding: 1 },
  rowPressed: { opacity: 0.5 },
  label: {},
  value: {},
};

function bridge(id: string, name: string) {
  return {
    id,
    name,
    bridgeUrl: `https://${id}.test`,
    bridgeToken: 'token',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function storeWith({
  profiles,
  activeProfileId,
  localAvailable,
  connected = true,
}: {
  profiles: ReturnType<typeof bridge>[];
  activeProfileId: string | null;
  localAvailable: boolean;
  connected?: boolean;
}) {
  const data = createDefaultAppStateData();
  data.bridgeProfiles = { activeProfileId, profiles };
  const store = createTestStore({ data });
  store.set(localProfileAvailableAtom, localAvailable);
  store.set(bridgeConnectedAtom, connected);
  return store;
}

function setupRuntime(patch: Partial<FakeSetupRuntimeState> = {}) {
  return createFakeSetupRuntime({
    modelId: MODEL,
    workspaceId: null,
    workspaces: [],
    downloadPhase: 'not_downloaded',
    ...patch,
  });
}

async function renderIn(store: ReturnType<typeof storeWith>, element: ReactElement) {
  return await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <Provider store={store}>{element}</Provider>
    </SafeAreaProvider>,
  );
}

function iconNames(): string[] {
  return screen
    .getAllByTestId('mock-ionicon', { includeHiddenElements: true })
    .map((node) => node.props['accessibilityLabel'] as string);
}

function expandedState(testID: string): boolean | undefined {
  const state = screen.getByTestId(testID).props['accessibilityState'] as
    { expanded?: boolean } | undefined;
  return state?.expanded;
}

async function pressedStyle(testID: string, pressed: boolean) {
  if (pressed) {
    await fireEvent(screen.getByTestId(testID), 'responderGrant', {
      persist: jest.fn(),
      nativeEvent: { timestamp: 0 },
      currentTarget: 1,
    });
  }
  return StyleSheet.flatten(screen.getByTestId(testID).props['style'] as never) as Record<
    string,
    unknown
  >;
}

describe('drawer profile row states', () => {
  it('renders nothing when there is only one bridge and no local agent to choose', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk')],
      activeProfileId: 'desk',
      localAvailable: false,
    });
    await renderIn(store, <DrawerProfileRow styles={ROW_STYLES} />);
    expect(screen.queryByTestId('drawer-profile-switcher')).toBeNull();
  });

  it('names the open bridge with its live connection state and host', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk'), bridge('lab', 'Lab')],
      activeProfileId: 'desk',
      localAvailable: false,
      connected: false,
    });
    await renderIn(store, <DrawerProfileRow styles={ROW_STYLES} />);

    const row = screen.getByTestId('drawer-profile-switcher');
    expect(row.props['accessibilityLabel']).toBe(
      `${PROFILE_SWITCHER_TITLE}, Desk, Disconnected · desk.test`,
    );
    expect(screen.getByText('Desk')).toBeTruthy();
    expect(iconNames()[0]).toBe('desktop-outline');
  });

  it('asks to choose when a persisted local selection is unavailable on this device', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk'), bridge('lab', 'Lab')],
      activeProfileId: LOCAL_PROFILE_ID,
      localAvailable: false,
    });
    await renderIn(store, <DrawerProfileRow styles={ROW_STYLES} />);

    expect(screen.getByTestId('drawer-profile-switcher').props['accessibilityLabel']).toBe(
      `${PROFILE_SWITCHER_TITLE}, No profile`,
    );
    expect(screen.getByText('Choose')).toBeTruthy();
    expect(iconNames()[0]).toBe('swap-horizontal-outline');
  });

  it('expands into the profile sheet on press and collapses when the sheet closes', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk')],
      activeProfileId: 'desk',
      localAvailable: true,
    });
    await renderIn(store, <DrawerProfileRow styles={ROW_STYLES} />);
    const expanded = () => expandedState('drawer-profile-switcher');
    expect(expanded()).toBe(false);

    await fireEvent.press(screen.getByTestId('drawer-profile-switcher'));
    expect(expanded()).toBe(true);
    expect(screen.getByLabelText('On this iPhone')).toBeTruthy();
    expect(screen.getByLabelText('Add bridge')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('selection-sheet-close'));
    expect(expanded()).toBe(false);
  });

  it('applies the drawer pressed style only while touched, without its own hairline', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk')],
      activeProfileId: 'desk',
      localAvailable: true,
    });
    await renderIn(store, <DrawerProfileRow styles={ROW_STYLES} />);

    expect(await pressedStyle('drawer-profile-switcher', false)).toEqual({
      padding: 1,
      borderBottomWidth: 0,
    });
    expect(await pressedStyle('drawer-profile-switcher', true)).toEqual({
      padding: 1,
      borderBottomWidth: 0,
      opacity: 0.5,
    });
  });
});

describe('new chat run target states', () => {
  it('renders nothing, including setup, when there is no choice to make', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk')],
      activeProfileId: 'desk',
      localAvailable: false,
    });
    await renderIn(store, <NewChatRunTarget />);
    expect(screen.queryByTestId('new-chat-profile-switcher')).toBeNull();
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
  });

  it('shows the bridge connection status next to its name', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk')],
      activeProfileId: 'desk',
      localAvailable: true,
    });
    await renderIn(store, <NewChatRunTarget />);

    expect(screen.getByText('Desk')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByTestId('new-chat-profile-switcher').props['accessibilityLabel']).toBe(
      `${PROFILE_SWITCHER_TITLE}, Desk, Connected · desk.test`,
    );
  });

  it('asks where to run, without a status, when no profile is open', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk'), bridge('lab', 'Lab')],
      activeProfileId: LOCAL_PROFILE_ID,
      localAvailable: false,
    });
    await renderIn(store, <NewChatRunTarget />);

    expect(screen.getByText('Choose where to run')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(iconNames()[0]).toBe('swap-horizontal-outline');
  });

  it('follows local setup status live and keeps the checklist until the first chat', async () => {
    const store = storeWith({
      profiles: [],
      activeProfileId: LOCAL_PROFILE_ID,
      localAvailable: true,
    });
    const fake = setupRuntime();
    store.set(localRuntimeAtom, fake.runtime);
    await renderIn(store, <NewChatRunTarget />);

    // Nothing is downloaded yet: the capsule shows the setup state and the checklist appears.
    expect(screen.getByText('On this iPhone')).toBeTruthy();
    expect(screen.getByText('Needs a model')).toBeTruthy();
    expect(screen.getByTestId('local-setup-guide')).toBeTruthy();
    expect(iconNames()[0]).toBe('phone-portrait-outline');

    await act(() =>
      fake.update({
        downloadPhase: 'ready',
        workspaceId: 'w1',
        workspaces: [{ id: 'w1', name: 'demo' }],
      }),
    );
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    // Ready to chat, the checklist stays to offer the Git author and the first chat.
    expect(screen.getByLabelText('4. Start your first chat, Ready')).toBeTruthy();

    await act(() => fake.update({ threadMessages: [1] }));
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
  });

  it('keeps the checklist hidden after the first chat even once every chat is deleted', async () => {
    const store = storeWith({
      profiles: [],
      activeProfileId: LOCAL_PROFILE_ID,
      localAvailable: true,
    });
    const fake = setupRuntime({
      downloadPhase: 'ready',
      workspaceId: 'w1',
      workspaces: [{ id: 'w1', name: 'demo' }],
    });
    store.set(localRuntimeAtom, fake.runtime);
    // The runtime host records completion app-wide; this stands in for it.
    function CompletionRecorder() {
      useRecordLocalSetupCompletion(fake.runtime);
      return null;
    }
    const screenWithGuide = (
      <>
        <CompletionRecorder />
        <NewChatRunTarget />
      </>
    );
    const view = await renderIn(store, screenWithGuide);
    expect(screen.getByTestId('local-setup-guide')).toBeTruthy();

    await act(() => fake.update({ threadMessages: [3] }));
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
    expect(store.get(localSetupCompletedAtom)).toBe(true);

    await act(() => fake.update({ threadMessages: [] }));
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
    await view.unmount();
    await renderIn(store, <NewChatRunTarget />);
    expect(
      screen.getByLabelText('Where agents run, On this iPhone, Ready · Private offline models'),
    ).toBeTruthy();
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
    expect(store.get(localSetupDismissedAtom)).toBe(false);
  });

  it('scales the capsule while pressed and opens the sheet', async () => {
    const store = storeWith({
      profiles: [bridge('desk', 'Desk')],
      activeProfileId: 'desk',
      localAvailable: true,
    });
    await renderIn(store, <NewChatRunTarget />);

    expect((await pressedStyle('new-chat-profile-switcher', false))['transform']).toBeUndefined();
    expect((await pressedStyle('new-chat-profile-switcher', true))['transform']).toEqual([
      { scale: 0.97 },
    ]);

    await fireEvent.press(screen.getByTestId('new-chat-profile-switcher'));
    expect(expandedState('new-chat-profile-switcher')).toBe(true);
  });
});

describe('local setup guide states', () => {
  beforeEach(() => {
    (router.push as jest.Mock).mockClear();
  });

  it('renders nothing while the local runtime is not open', async () => {
    const store = storeWith({
      profiles: [],
      activeProfileId: LOCAL_PROFILE_ID,
      localAvailable: true,
    });
    await renderIn(store, <LocalSetupGuide />);
    expect(screen.queryByTestId('local-setup-guide')).toBeNull();
  });

  it('marks a download in progress and routes each step to where it is completed', async () => {
    const store = storeWith({
      profiles: [],
      activeProfileId: LOCAL_PROFILE_ID,
      localAvailable: true,
    });
    store.set(localRuntimeAtom, setupRuntime({ downloadPhase: 'downloading' }).runtime);
    await renderIn(store, <LocalSetupGuide />);

    expect(screen.getByText('Downloading')).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();

    await fireEvent.press(screen.getByText('1. Download a model'));
    expect(router.push).toHaveBeenCalledWith(LOCAL_SETUP_DESTINATIONS.models);
  });
});
