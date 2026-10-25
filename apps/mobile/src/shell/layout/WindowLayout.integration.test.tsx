import { Provider, createStore } from 'jotai';
import { Dimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { TABLET_SIDEBAR_WIDTH } from '@shell/boot/appConstants';
import { appSettingsAtom } from '@shell/state/appState/atoms';
import { sidebarHiddenAtom } from '@shell/state/appState/settings';
import { windowTraitsAtom } from '@shell/state/layout/atoms';
import { createTestStore } from '@shell/state/testing';
import {
  useSceneHorizontalInsets,
  useShellLayout,
  useVerticalBarFrame,
  type SceneHorizontalInsets,
} from './useShellLayout';
import { WindowLayoutObserver } from './WindowLayoutObserver.native';
import type { LayoutRect, ShellLayout } from './windowLayout';

// The iPhone Duo status bar and camera sit in a vertical column on the trailing edge.
const DUO_TRAILING_INSET = 84;

type Queryable = ReactTestInstance & {
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

let observed: {
  layout: ShellLayout;
  insets: SceneHorizontalInsets;
  verticalBar: LayoutRect | null;
} | null = null;

function LayoutProbe() {
  observed = {
    layout: useShellLayout(),
    insets: useSceneHorizontalInsets(),
    verticalBar: useVerticalBarFrame(),
  };
  return null;
}

// Payloads captured from the iOS 27.1 iPhone Duo simulator.
const DUO_CLOSED = {
  horizontalSizeClass: 'compact',
  verticalSizeClass: 'regular',
  verticalBarEdge: 'trailing',
  divisions: [],
  occlusions: [
    { x: 399.67, y: 29.33, width: 37, height: 37 },
    { x: 382, y: 0, width: 84, height: 174 },
  ],
  statusBar: { x: 0, y: 0, width: 466, height: 2 },
};
const DUO_OPEN = {
  horizontalSizeClass: 'regular',
  verticalSizeClass: 'compact',
  verticalBarEdge: 'trailing',
  divisions: [],
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }],
  statusBar: { x: 0, y: 0, width: 951, height: 2 },
};
const BOOK_FOLD = { x: 455, y: 0, width: 41, height: 669 };

function setWindowSize(width: number, height: number) {
  act(() => {
    Dimensions.set({
      window: { width, height, scale: 3, fontScale: 1 },
      screen: { width, height, scale: 3, fontScale: 1 },
    });
  });
}

function findObserver(tree: ReactTestRenderer): Queryable | undefined {
  return (tree.root as Queryable).findAll(
    (node) => typeof node.props['onWindowLayoutChange'] === 'function',
  )[0];
}

function emitNativeTraits(tree: ReactTestRenderer, payload: unknown) {
  const observer = findObserver(tree);
  if (!observer) {
    throw new Error('Expected the native window layout observer');
  }
  act(() => {
    (observer.props['onWindowLayoutChange'] as (event: unknown) => void)({ nativeEvent: payload });
  });
}

describe('iPhone Duo window layout', () => {
  afterEach(() => {
    observed = null;
    setWindowSize(750, 1334);
  });

  it('follows the device from closed to open to folded and back', () => {
    const store = createTestStore();
    setWindowSize(466, 678);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 466, height: 678 },
            insets: { top: 0, left: 0, right: DUO_TRAILING_INSET, bottom: 20 },
          }}
        >
          <Provider store={store}>
            <WindowLayoutObserver />
            <LayoutProbe />
          </Provider>
        </SafeAreaProvider>,
      );
    });
    expect(findObserver(tree)?.props['pointerEvents']).toBe('none');

    // Closed: compact outer display with bars on the trailing edge, starting below the status
    // column the system reports as an occlusion. The chat avoids that column.
    emitNativeTraits(tree, DUO_CLOSED);
    expect(observed).toEqual({
      layout: {
        sidebarMode: 'overlay',
        sidebarWidth: 466,
        sidebarSpansWindow: true,
        toolbarPlacement: 'trailing',
        fold: null,
      },
      insets: { paddingLeft: 0, paddingRight: DUO_TRAILING_INSET },
      verticalBar: { x: 382, y: 182, width: 84, height: 678 - 20 - 182 },
    });

    // Open in landscape: the sidebar is shown by default and owns the leading edge; the bars stay
    // on the trailing edge.
    setWindowSize(951, 669);
    emitNativeTraits(tree, DUO_OPEN);
    expect(observed?.layout).toEqual({
      sidebarMode: 'docked',
      sidebarWidth: TABLET_SIDEBAR_WIDTH,
      sidebarSpansWindow: false,
      toolbarPlacement: 'trailing',
      fold: null,
    });
    expect(observed?.insets).toEqual({ paddingLeft: 0, paddingRight: DUO_TRAILING_INSET });
    expect(observed?.verticalBar?.y).toBe(132);

    // Hiding the sidebar gives the chat the whole window, and the choice is remembered.
    act(() => store.set(sidebarHiddenAtom, true));
    expect(observed?.layout.sidebarMode).toBe('collapsed');
    expect(store.get(appSettingsAtom).sidebarHidden).toBe(true);
    act(() => store.set(sidebarHiddenAtom, false));
    expect(observed?.layout.sidebarMode).toBe('docked');

    // Book pose: the chat keeps the full width; the session list waits behind the menu and, when
    // opened, covers only the leading page.
    emitNativeTraits(tree, { ...DUO_OPEN, divisions: [BOOK_FOLD] });
    expect(observed?.layout).toEqual({
      sidebarMode: 'overlay',
      sidebarWidth: 455,
      sidebarSpansWindow: false,
      toolbarPlacement: 'trailing',
      fold: BOOK_FOLD,
    });
    expect(observed?.insets).toEqual({ paddingLeft: 0, paddingRight: DUO_TRAILING_INSET });

    // Flat again: the fold region goes inactive and the docked sidebar returns.
    emitNativeTraits(tree, DUO_OPEN);
    expect(observed?.layout.sidebarMode).toBe('docked');

    // Laptop pose: portrait, so bars are horizontal again, and the fold runs across the window.
    // The narrow window keeps the session list behind the menu, and controls move to the bottom.
    setWindowSize(669, 951);
    emitNativeTraits(tree, {
      horizontalSizeClass: 'regular',
      verticalSizeClass: 'regular',
      verticalBarEdge: 'unspecified',
      divisions: [{ x: 0, y: 455.5, width: 669, height: 40 }],
      occlusions: [],
    });
    expect(observed?.layout).toEqual({
      sidebarMode: 'overlay',
      sidebarWidth: 669,
      sidebarSpansWindow: true,
      toolbarPlacement: 'bottom',
      fold: null,
    });
    expect(observed?.verticalBar).toBeNull();

    // Closed again.
    setWindowSize(466, 678);
    emitNativeTraits(tree, DUO_CLOSED);
    expect(observed?.layout).toMatchObject({
      sidebarMode: 'overlay',
      toolbarPlacement: 'trailing',
    });

    act(() => tree.unmount());
  });

  it('falls back to the width breakpoint when the native payload is unusable', () => {
    const store = createStore();
    setWindowSize(951, 669);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <Provider store={store}>
          <WindowLayoutObserver />
          <LayoutProbe />
        </Provider>,
      );
    });

    emitNativeTraits(tree, { horizontalSizeClass: 'compact', verticalSizeClass: 'regular' });
    expect(observed?.layout.sidebarMode).toBe('overlay');

    emitNativeTraits(tree, { horizontalSizeClass: 42 });
    expect(store.get(windowTraitsAtom)).toBeNull();
    expect(observed?.layout.sidebarMode).toBe('docked');

    act(() => tree.unmount());
  });
});
