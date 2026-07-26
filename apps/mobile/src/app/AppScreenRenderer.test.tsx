import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppScreenRenderer } from './AppScreenRenderer';
import { createBridgeTestStore, withAppStore } from '../state/testing';
import { gitChatAtom } from '../state/chat/atoms';
import { currentScreenAtom } from '../state/navigation/atoms';
import type { Chat } from '../api/types';
import type { HostBridgeApiClient } from '../api/client';
import type { AppStore } from '../state/types';

let mainMountCount = 0;

jest.mock('react-native-reanimated', () => {
  const MockView = jest.requireActual('react-native').View;
  return { __esModule: true, default: { View: MockView } };
});

jest.mock('../screens/main/MainScreen', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    MainScreen: () => {
      mockReact.useEffect(() => {
        mainMountCount += 1;
      }, []);
      return mockReact.createElement(MockText, null, 'MAIN');
    },
  };
});
jest.mock('../screens/workspacePicker/WorkspacePickerScreen', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return { WorkspacePickerScreen: () => mockReact.createElement(MockText, null, 'PICKER') };
});
jest.mock('../screens/gitCheckout/GitCheckoutScreen', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return { GitCheckoutScreen: () => mockReact.createElement(MockText, null, 'CHECKOUT') };
});
jest.mock('../screens/browser/BrowserScreen', () => ({ BrowserScreen: () => null }));
jest.mock('../screens/git/GitScreen', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return { GitScreen: () => mockReact.createElement(MockText, null, 'GIT') };
});
jest.mock('../screens/settings/SettingsScreen', () => ({ SettingsScreen: () => null }));
jest.mock('../screens/legal/PrivacyScreen', () => ({ PrivacyScreen: () => null }));
jest.mock('../screens/legal/TermsScreen', () => ({ TermsScreen: () => null }));

function textOf(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON() ?? null);
}

function render(store: AppStore): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(withAppStore(store, <AppScreenRenderer />));
  });
  if (!tree) throw new Error('Expected renderer');
  return tree;
}

describe('AppScreenRenderer', () => {
  beforeEach(() => {
    mainMountCount = 0;
  });

  it('keeps the chat mounted while pushing and popping screens over it', () => {
    // A remount would run MainScreen's screen-atom reset, wiping the composer draft and any
    // in-flight chat creation.
    const store = createBridgeTestStore({ api: {} as unknown as HostBridgeApiClient });
    const tree = render(store);
    expect(mainMountCount).toBe(1);
    expect(textOf(tree)).toContain('MAIN');

    act(() => store.set(currentScreenAtom, 'WorkspacePicker'));
    expect(textOf(tree)).toContain('PICKER');
    expect(textOf(tree)).toContain('MAIN');
    expect(mainMountCount).toBe(1);

    act(() => store.set(currentScreenAtom, 'GitCheckout'));
    expect(textOf(tree)).toContain('CHECKOUT');
    expect(mainMountCount).toBe(1);

    const chat = {
      id: 'chat-1',
      title: 'Chat',
      status: 'complete',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      statusUpdatedAt: '2026-07-20T00:00:00.000Z',
      lastMessagePreview: '',
      messages: [],
    } as Chat;
    act(() => {
      store.set(gitChatAtom, chat);
      store.set(currentScreenAtom, 'ChatGit');
    });
    expect(textOf(tree)).toContain('GIT');
    expect(textOf(tree)).toContain('MAIN');
    expect(mainMountCount).toBe(1);

    act(() => store.set(currentScreenAtom, 'Main'));
    expect(textOf(tree)).not.toContain('CHECKOUT');
    expect(textOf(tree)).not.toContain('GIT');
    expect(mainMountCount).toBe(1);

    act(() => tree.unmount());
  });

  it('hides the chat from touches and assistive tech while a screen is pushed', () => {
    const store = createBridgeTestStore({ api: {} as unknown as HostBridgeApiClient });
    const tree = render(store);
    const underlay = () =>
      (
        tree.root as unknown as {
          findAll(predicate: (node: { props: Record<string, unknown> }) => boolean): {
            props: Record<string, unknown>;
          }[];
        }
      ).findAll(
        (node) => node.props.pointerEvents === 'none' || node.props.pointerEvents === 'auto',
      )[0];

    expect(underlay().props.pointerEvents).toBe('auto');
    expect(underlay().props.accessibilityElementsHidden).toBe(false);

    act(() => store.set(currentScreenAtom, 'WorkspacePicker'));
    expect(underlay().props.pointerEvents).toBe('none');
    expect(underlay().props.accessibilityElementsHidden).toBe(true);

    act(() => tree.unmount());
  });
});
