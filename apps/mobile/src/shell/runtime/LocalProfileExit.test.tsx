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
});
