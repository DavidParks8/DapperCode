import { Provider, createStore } from 'jotai';
import { Dimensions, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
  SafeAreaInsetsContext,
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { TABLET_SIDEBAR_WIDTH } from '@shell/boot/appConstants';
import { appSettingsAtom } from '@shell/state/appState/atoms';
import { sidebarHiddenAtom } from '@shell/state/appState/settings';
import { windowTraitsAtom } from '@shell/state/layout/atoms';
import { createTestStore } from '@shell/state/testing';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ChatHeader } from '../../features/chat/screen/ChatHeader';
import {
  useSceneHorizontalInsets,
  useShellLayout,
  useVerticalBarFrame,
  type SceneHorizontalInsets,
} from './useShellLayout';
import { WindowLayoutObserver } from './WindowLayoutObserver.native';
import type { LayoutRect, ShellLayout } from './windowLayout';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

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
  verticalBarLayout: { x: 394, y: 174, width: 48, height: 470 },
};
const DUO_OPEN = {
  horizontalSizeClass: 'regular',
  verticalSizeClass: 'compact',
  verticalBarEdge: 'trailing',
  divisions: [],
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }],
  statusBar: { x: 0, y: 0, width: 951, height: 2 },
  verticalBarLayout: { x: 879, y: 124, width: 48, height: 511 },
  headerLayout: { x: 16, y: 0, width: 851, height: 635 },
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
      verticalBar: { x: 394, y: 182, width: 48, height: 462 },
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
    expect(observed?.verticalBar).toEqual({ x: 879, y: 132, width: 48, height: 503 });

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

  it('keeps a compact header clear of corners through docking, safe-area changes, and laptop pose', () => {
    const store = createTestStore();
    store.set(sidebarHiddenAtom, true);
    setWindowSize(951, 669);
    const content = (top = 0, respectsTopSafeArea = true) => (
      <SafeAreaInsetsContext.Provider value={{ top, left: 0, right: 84, bottom: 34 }}>
        <Provider store={store}>
          <AppThemeProvider theme={createAppTheme('dark')}>
            <WindowLayoutObserver />
            <ChatHeader title="Corner-aware title" respectsTopSafeArea={respectsTopSafeArea} />
          </AppThemeProvider>
        </Provider>
      </SafeAreaInsetsContext.Provider>
    );
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(content());
    });
    const safeAreaStyle = () =>
      StyleSheet.flatten(tree.root.findByType(SafeAreaView).props['style'] as StyleProp<ViewStyle>);
    const headerStyle = () =>
      StyleSheet.flatten(tree.root.findByProps({ testID: 'chat-header-row' }).props['style']);

    emitNativeTraits(tree, { ...DUO_OPEN, topBarInset: 24 });
    expect(safeAreaStyle()?.paddingTop ?? 0).toBe(0);
    expect(safeAreaStyle()).toMatchObject({ paddingRight: 84 });
    expect(headerStyle()).toMatchObject({ paddingLeft: 32, minHeight: 48 });
    expect(
      StyleSheet.flatten(
        tree.root.findByProps({ testID: 'chat-header-title-overflow' }).props['style'],
      ),
    ).toMatchObject({ height: 48 });

    act(() => store.set(sidebarHiddenAtom, false));
    expect(headerStyle()).toMatchObject({ paddingLeft: 16 });
    act(() => store.set(sidebarHiddenAtom, true));
    expect(headerStyle()).toMatchObject({ paddingLeft: 32 });

    act(() => tree.update(content(47)));
    expect(headerStyle()).toMatchObject({ paddingLeft: 16 });

    act(() => tree.update(content(0, false)));
    expect(headerStyle()).toMatchObject({ paddingLeft: 16 });
    expect(tree.root.findByType(SafeAreaView).props['edges']).toEqual([]);

    act(() => tree.update(content()));
    expect(headerStyle()).toMatchObject({ paddingLeft: 32 });
    emitNativeTraits(tree, {
      ...DUO_OPEN,
      verticalBarEdge: 'unspecified',
      headerLayout: undefined,
    });
    expect(headerStyle()).toMatchObject({ paddingLeft: 16 });
    emitNativeTraits(tree, DUO_OPEN);
    expect(headerStyle()).toMatchObject({ paddingLeft: 32 });

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
