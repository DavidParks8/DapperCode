jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@shell/session/chatSnapshotCache', () => ({
  ...jest.requireActual('@shell/session/chatSnapshotCache'),
  loadChatSnapshotCache: jest.fn().mockResolvedValue(null),
}));

import { router, usePathname } from 'expo-router';
import { Text } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { createDefaultAppStateData, parsePersistedAppState } from '@shell/state/appState';
import { activeProfileIdAtom, localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createMemoryPersistence, createTestStore, withAppStore } from '@shell/state/testing';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { LocalProfileExit } from './LocalProfileExit';

function Path() {
  return <Text testID="path">{usePathname()}</Text>;
}

describe('LocalProfileExit', () => {
  it('closes the local profile before onboarding when no desktop profile exists', async () => {
    const persistence = createMemoryPersistence();
    const data = createDefaultAppStateData();
    data.bridgeProfiles = { activeProfileId: LOCAL_PROFILE_ID, profiles: [] };
    const store = createTestStore({ data, persistence });
    store.set(localProfileAvailableAtom, true);
    act(() => router.replace('/profiles/on-device/chats/new'));
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        withAppStore(
          store,
          <AppThemeProvider theme={createAppTheme('light')}>
            <LocalProfileExit />
            <Path />
          </AppThemeProvider>,
        ),
      );
    });
    type Node = {
      props: Record<string, unknown>;
      parent: Node | null;
      findAllByType(type: unknown): Node[];
    };
    const root = tree!.root as unknown as Node;
    const label = root
      .findAllByType(Text)
      .find((node) => node.props['children'] === 'Connect a desktop instead');
    let action = label?.parent ?? null;
    while (action && typeof action.props['onPress'] !== 'function') {
      action = action.parent;
    }
    await act(async () => {
      (action!.props['onPress'] as () => void)();
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }
    });

    expect(store.get(activeProfileIdAtom)).toBeNull();
    // A cold start reads the persisted state and must not reopen the local chat.
    expect(
      parsePersistedAppState(persistence.writes.at(-1)!).bridgeProfiles.activeProfileId,
    ).toBeNull();
    expect(tree!.root.findByProps({ testID: 'path' }).props['children']).toBe('/onboarding');
    act(() => tree!.unmount());
  });
  it('keeps the local profile open and offers a retry when closing it cannot be saved', async () => {
    const persistence = createMemoryPersistence();
    const write = persistence.writeCurrent;
    let failNextWrite = true;
    persistence.writeCurrent = (raw) => {
      if (failNextWrite) {
        failNextWrite = false;
        return Promise.reject(new Error('disk full'));
      }
      return write(raw);
    };
    const data = createDefaultAppStateData();
    data.bridgeProfiles = { activeProfileId: LOCAL_PROFILE_ID, profiles: [] };
    const store = createTestStore({ data, persistence });
    store.set(localProfileAvailableAtom, true);
    act(() => router.replace('/profiles/on-device/chats/new'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        withAppStore(
          store,
          <AppThemeProvider theme={createAppTheme('light')}>
            <LocalProfileExit />
            <Path />
          </AppThemeProvider>,
        ),
      );
    });
    type Node = {
      props: Record<string, unknown>;
      parent: Node | null;
      findAllByType(type: unknown): Node[];
    };
    const root = tree!.root as unknown as Node;
    const press = async (label: string) => {
      const text = root.findAllByType(Text).find((node) => node.props['children'] === label);
      let action = text?.parent ?? null;
      while (action && typeof action.props['onPress'] !== 'function') {
        action = action.parent;
      }
      await act(async () => {
        (action!.props['onPress'] as () => void)();
        for (let index = 0; index < 10; index += 1) {
          await Promise.resolve();
        }
      });
    };
    const texts = () => root.findAllByType(Text).map((node) => node.props['children']);

    await press('Connect a desktop instead');
    expect(texts()).toContain('The app-state change was not saved. Please retry.');
    expect(store.get(activeProfileIdAtom)).toBe(LOCAL_PROFILE_ID);
    expect(tree!.root.findByProps({ testID: 'path' }).props['children']).toBe(
      '/profiles/on-device/chats/new',
    );
    expect(persistence.writes).toHaveLength(0);

    await press('Retry connecting a desktop');
    expect(store.get(activeProfileIdAtom)).toBeNull();
    expect(
      parsePersistedAppState(persistence.writes.at(-1)!).bridgeProfiles.activeProfileId,
    ).toBeNull();
    expect(tree!.root.findByProps({ testID: 'path' }).props['children']).toBe('/onboarding');
    expect(texts()).not.toContain('The app-state change was not saved. Please retry.');
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    act(() => tree!.unmount());
  });
});
