import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppScreenRenderer } from './AppScreenRenderer';
import { createBridgeTestStore, withAppStore } from '../state/testing';
import { currentScreenAtom } from '../state/navigation/atoms';
import type { HostBridgeApiClient } from '../api/client';
import type { AppStore } from '../state/types';

let mainMountCount = 0;

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
jest.mock('../screens/git/GitScreen', () => ({ GitScreen: () => null }));
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

    act(() => store.set(currentScreenAtom, 'Main'));
    expect(textOf(tree)).not.toContain('CHECKOUT');
    expect(mainMountCount).toBe(1);

    act(() => tree.unmount());
  });

  it('hides the chat from touches and assistive tech while a screen is pushed', () => {
    const store = createBridgeTestStore({ api: {} as unknown as HostBridgeApiClient });
    const tree = render(store);
    const underlay = () =>
      (tree.root as unknown as {
        findAll(predicate: (node: { props: Record<string, unknown> }) => boolean): {
          props: Record<string, unknown>;
        }[];
      }).findAll((node) => node.props.pointerEvents === 'none' || node.props.pointerEvents === 'auto')[0];

    expect(underlay().props.pointerEvents).toBe('auto');
    expect(underlay().props.accessibilityElementsHidden).toBe(false);

    act(() => store.set(currentScreenAtom, 'WorkspacePicker'));
    expect(underlay().props.pointerEvents).toBe('none');
    expect(underlay().props.accessibilityElementsHidden).toBe(true);

    act(() => tree.unmount());
  });
});
