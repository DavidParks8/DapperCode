let mockOnboardingProps: Record<string, unknown> | null = null;
const mockSaveBridgeProfile = jest.fn().mockResolvedValue('profile-2');

jest.mock('expo-router', () => jest.requireActual('../testing/expoRouterMock'));
jest.mock('../screens/onboarding/OnboardingScreen', () => ({
  OnboardingScreen: (props: Record<string, unknown>) => {
    mockOnboardingProps = props;
    return null;
  },
}));
jest.mock('../state/bridge/actions', () => {
  const { atom } = jest.requireActual('jotai');
  return {
    saveBridgeProfileAtom: atom(null, (_get: unknown, _set: unknown, input: unknown) =>
      mockSaveBridgeProfile(input),
    ),
  };
});

import { router } from 'expo-router';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { routes } from '../navigation/routes';
import { createBridgeTestStore, createTestStore, withAppStore } from '../state/testing';
import { ConnectionScreen } from './AppShells';

function renderConnection(
  mode: 'initial' | 'add' | 'edit' | 'reconnect',
  withProfile = true,
): ReactTestRenderer {
  const store = withProfile ? createBridgeTestStore({ api: {} as never }) : createTestStore();
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      withAppStore(store, <ConnectionScreen mode={mode} profileId="profile-1" />),
    );
  });
  if (!tree) throw new Error('Expected connection screen');
  return tree;
}

describe('ConnectionScreen', () => {
  beforeEach(() => {
    mockOnboardingProps = null;
    mockSaveBridgeProfile.mockClear();
  });

  it('lets the protected-route flip own initial onboarding navigation', async () => {
    const tree = renderConnection('initial', false);
    await act(async () => {
      await (
        mockOnboardingProps?.onSave as (draft: {
          bridgeUrl: string;
          bridgeToken: string;
        }) => Promise<void>
      )({ bridgeUrl: 'https://bridge.test', bridgeToken: 'token' });
    });
    expect(mockSaveBridgeProfile).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'initial' }),
    );
    expect(router.replace).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('uses saved credentials for edit/reconnect and returns through Router history', async () => {
    act(() => router.push(routes.settings('profile-1')));
    const tree = renderConnection('edit');
    expect(mockOnboardingProps).toEqual(
      expect.objectContaining({
        mode: 'edit',
        initialBridgeUrl: 'https://bridge.test',
        initialBridgeToken: 'token',
      }),
    );
    act(() => (mockOnboardingProps?.onCancel as () => void)());
    expect(router.back).toHaveBeenCalled();
    act(() => tree.unmount());

    const reconnectTree = renderConnection('reconnect');
    expect(mockOnboardingProps).toEqual(expect.objectContaining({ mode: 'reconnect' }));
    act(() => reconnectTree.unmount());
  });

  it('replaces non-initial saves with the activated profile root', async () => {
    const tree = renderConnection('add');
    await act(async () => {
      await (
        mockOnboardingProps?.onSave as (draft: {
          bridgeUrl: string;
          bridgeToken: string;
        }) => Promise<void>
      )({ bridgeUrl: 'https://two.test', bridgeToken: 'two' });
    });
    expect(router.replace).toHaveBeenCalledWith(routes.newChat('profile-2'));
    act(() => tree.unmount());
  });
});
