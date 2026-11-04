let mockRootStackProps: Record<string, unknown> | null = null;

jest.mock('expo-router', () => {
  const routerMock = jest.requireActual('@shared/testing/expoRouterMock');
  const Stack = Object.assign(
    (props: Record<string, unknown>) => {
      mockRootStackProps = props;
      return null;
    },
    {
      Protected: () => null,
      Screen: () => null,
    },
  );
  return { ...routerMock, Stack };
});
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('@shared/testing/gestureHandlerMock'),
);
// OnboardingScreen renders an Animated.View for its connect step, which needs the worklet-free
// double below since Jest has no native reanimated runtime.
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual('react');
  return {
    initialWindowMetrics: null,
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});
jest.mock('@shell/boot/useAppBridgeLifecycle', () => ({ useAppBridgeLifecycle: jest.fn() }));
jest.mock('@shell/boot/useAppStoreReview', () => ({ useAppStoreReview: jest.fn() }));
jest.mock('@shell/boot/usePushNotificationsLifecycle', () => ({
  usePushNotificationsLifecycle: jest.fn(),
}));
jest.mock('@shell/runtime/LocalRuntimeHost', () => ({
  LocalRuntimeHost: () => 'local-runtime-host',
}));

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppStatePersistenceError } from '@shell/state/appState';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { chatSnapshotCacheAtom } from '@shell/state/chat/atoms';
import { createTestStore, withAppStore } from '@shell/state/testing';
import { themeAtom } from '@shell/state/theme';
import { RootLayout } from '@shell/boot/RootLayout';
import { useAppBridgeLifecycle } from '@shell/boot/useAppBridgeLifecycle';
import { usePushNotificationsLifecycle } from '@shell/boot/usePushNotificationsLifecycle';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';

function renderRoot(store = createTestStore()): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(withAppStore(store, <RootLayout />));
  });
  if (!tree) {
    throw new Error('Expected root layout');
  }
  return tree;
}

function jsonOf(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON());
}

describe('RootLayout', () => {
  beforeEach(() => {
    mockRootStackProps = null;
    jest.clearAllMocks();
  });

  it('shows the startup shell until persisted state and chat cache are ready', () => {
    const store = createTestStore({ loaded: false });
    const tree = renderRoot(store);
    expect(jsonOf(tree)).toContain('Loading DapperCode');
    act(() => tree.unmount());
  });

  it('shows typed read recovery without hiding write-only failures', () => {
    const store = createTestStore();
    store.set(chatSnapshotCacheAtom, null);
    store.set(appStateSnapshotAtom, {
      ...store.get(appStateSnapshotAtom),
      persistenceError: new AppStatePersistenceError('read_failed', 'load', 'read failed'),
    });
    const readTree = renderRoot(store);
    expect(jsonOf(readTree)).toContain('Could not load saved app state');
    act(() => readTree.unmount());

    store.set(appStateSnapshotAtom, {
      ...store.get(appStateSnapshotAtom),
      persistenceError: new AppStatePersistenceError('write_failed', 'write', 'write failed'),
    });
    const writeTree = renderRoot(store);
    expect(jsonOf(writeTree)).not.toContain('Could not load saved app state');
    act(() => writeTree.unmount());
  });

  it('colors the root stack scene behind full-screen transitions', () => {
    const store = createTestStore();
    store.set(chatSnapshotCacheAtom, null);
    const tree = renderRoot(store);
    if (!mockRootStackProps) {
      throw new Error('Expected root Stack props');
    }

    expect(mockRootStackProps['screenOptions']).toMatchObject({
      contentStyle: { backgroundColor: store.get(themeAtom).colors.bgMain },
    });

    act(() => tree.unmount());
  });

  it('runs profile lifecycles for every profile and always mounts the local runtime host', () => {
    const store = createTestStore();
    store.set(chatSnapshotCacheAtom, null);
    const tree = renderRoot(store);
    expect(useAppBridgeLifecycle).toHaveBeenCalled();
    expect(usePushNotificationsLifecycle).toHaveBeenCalled();
    expect(jsonOf(tree)).toContain('local-runtime-host');
    act(() => tree.unmount());
  });

  it.each([
    { available: false, profiles: false, guards: [false, true] },
    { available: true, profiles: false, guards: [true, true] },
  ])(
    'opens profile routes for the local profile only where it is supported ($available)',
    ({ available, guards }) => {
      const store = createTestStore();
      store.set(chatSnapshotCacheAtom, null);
      store.set(localProfileAvailableAtom, available);
      const snapshot = store.get(appStateSnapshotAtom);
      store.set(appStateSnapshotAtom, {
        ...snapshot,
        data: {
          ...snapshot.data,
          bridgeProfiles: { activeProfileId: LOCAL_PROFILE_ID, profiles: [] },
        },
      });
      const tree = renderRoot(store);
      const children = (mockRootStackProps?.['children'] ?? []) as {
        props: { guard?: unknown };
      }[];
      // [profiles route guard, onboarding guard]
      expect(
        children.map((child) => child.props.guard).filter((guard) => guard !== undefined),
      ).toEqual(guards);
      act(() => tree.unmount());
    },
  );
});
