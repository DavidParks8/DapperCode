let mockDrawerProps: Record<string, unknown> | null = null;

jest.mock('expo-router/drawer', () => ({
  Drawer: (props: Record<string, unknown>) => {
    mockDrawerProps = props;
    return null;
  },
  useDrawerStatus: () => 'closed',
}));
jest.mock('@shell/navigation/DrawerContent', () => ({ DrawerContent: () => null }));

import type { ReactNode } from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ResponsiveDrawerLayout } from '../../app/profiles/[profileId]/(drawer)/_layout';
import { TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_WIDTH } from '@shell/boot/appConstants';
import { resolveShellLayout, type WindowTraits } from '@shell/layout/windowLayout';
import { sidebarHiddenAtom } from '@shell/state/appState/settings';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { createTestStore, withAppStore } from '@shell/state/testing';

function size(width: number, height = 900) {
  return { width, height };
}

interface DrawerScreenOptions {
  drawerStyle: { width: number; backgroundColor: string };
  drawerType: 'front' | 'permanent';
  overlayColor: string;
  sceneStyle: { backgroundColor: string };
  swipeEnabled: boolean;
}

function renderLayout(
  width: number,
  traits: WindowTraits | null = null,
  sidebarHidden = false,
): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ResponsiveDrawerLayout layout={resolveShellLayout(size(width), traits, sidebarHidden)} />,
    );
  });
  if (!tree) {
    throw new Error('Expected drawer layout');
  }
  return tree;
}

function readScreenOptions(): DrawerScreenOptions {
  if (!mockDrawerProps) {
    throw new Error('Expected Drawer props');
  }
  return mockDrawerProps['screenOptions'] as DrawerScreenOptions;
}

describe('DrawerLayout responsive sizing', () => {
  beforeEach(() => {
    mockDrawerProps = null;
  });

  it.each([320, 390, 430, TABLET_LAYOUT_MIN_WIDTH - 1])(
    'fills the session list to the compact viewport width (%i px)',
    (width) => {
      const tree = renderLayout(width);

      expect(readScreenOptions()).toMatchObject({
        drawerType: 'front',
        swipeEnabled: true,
        drawerStyle: { width },
        sceneStyle: { backgroundColor: '#000000' },
      });

      act(() => tree.unmount());
    },
  );

  it('becomes a push-aside sidebar when the window reaches tablet width', () => {
    const tree = renderLayout(430);

    act(() =>
      tree.update(<ResponsiveDrawerLayout layout={resolveShellLayout(size(1024), null)} />),
    );

    expect(readScreenOptions()).toMatchObject({
      drawerType: 'permanent',
      swipeEnabled: false,
      drawerStyle: { width: TABLET_SIDEBAR_WIDTH, backgroundColor: 'transparent' },
      overlayColor: 'transparent',
    });

    act(() => tree.unmount());
  });

  it('hides the sidebar behind the menu in a narrow portrait window with a regular size class', () => {
    // The open iPhone Duo rotated to portrait is 669pt wide and reports a regular size class.
    const tree = renderLayout(669, {
      horizontalSizeClass: 'regular',
      verticalSizeClass: 'regular',
      divisions: [],
    });

    expect(readScreenOptions()).toMatchObject({
      drawerType: 'front',
      swipeEnabled: true,
      drawerStyle: { width: 669 },
    });

    act(() => tree.unmount());
  });

  it('presents the session list over the chat on a compact display at any width', () => {
    const tree = renderLayout(TABLET_LAYOUT_MIN_WIDTH + 100, {
      horizontalSizeClass: 'compact',
      verticalSizeClass: 'regular',
      divisions: [],
    });

    expect(readScreenOptions()).toMatchObject({
      drawerType: 'front',
      swipeEnabled: true,
      drawerStyle: { width: TABLET_LAYOUT_MIN_WIDTH + 100 },
    });

    act(() => tree.unmount());
  });

  it('keeps the chat on its own page and the session list behind the menu in a book fold', () => {
    const regular = { horizontalSizeClass: 'regular', verticalSizeClass: 'compact' } as const;
    const tree = renderLayout(951, { ...regular, divisions: [] });
    expect(readScreenOptions().drawerType).toBe('permanent');

    act(() =>
      tree.update(
        <ResponsiveDrawerLayout
          layout={resolveShellLayout(size(951), {
            ...regular,
            divisions: [{ x: 455, y: 0, width: 41, height: 669 }],
          })}
        />,
      ),
    );
    // Opening the list covers only the leading page, so it never takes space from the chat.
    expect(readScreenOptions()).toMatchObject({
      drawerType: 'front',
      swipeEnabled: true,
      drawerStyle: { width: 455 },
    });

    act(() => tree.unmount());
  });

  it('collapses the docked sidebar without turning it into a swipeable overlay', () => {
    const tree = renderLayout(1024, null, true);

    expect(readScreenOptions()).toMatchObject({
      drawerType: 'front',
      swipeEnabled: false,
      drawerStyle: { width: TABLET_SIDEBAR_WIDTH },
    });

    act(() => tree.unmount());
  });

  it('toggles the remembered sidebar preference from the navigation control on wide windows', () => {
    const store = createTestStore();
    const navigation = { closeDrawer: jest.fn(), toggleDrawer: jest.fn(), openDrawer: jest.fn() };
    const renderContent = (hidden: boolean) => {
      const tree = renderLayout(1024, null, hidden);
      const drawerContent = mockDrawerProps?.['drawerContent'] as (props: unknown) => ReactNode;
      act(() => tree.update(withAppStore(store, drawerContent({ navigation }))));
      return tree;
    };

    let tree = renderContent(false);
    expect(store.get(drawerCommandsAtom)?.navigationLabel).toBe('Hide sidebar');
    act(() => store.get(drawerCommandsAtom)?.toggleNavigation?.());
    expect(store.get(sidebarHiddenAtom)).toBe(true);
    expect(navigation.toggleDrawer).not.toHaveBeenCalled();
    act(() => tree.unmount());

    tree = renderContent(true);
    expect(store.get(drawerCommandsAtom)?.navigationLabel).toBe('Show sidebar');
    act(() => store.get(drawerCommandsAtom)?.toggleNavigation?.());
    expect(store.get(sidebarHiddenAtom)).toBe(false);
    act(() => tree.unmount());
    expect(store.get(drawerCommandsAtom)).toBeNull();
  });

  it('opens the overlay drawer from the navigation control on narrow windows', () => {
    const store = createTestStore();
    const navigation = { closeDrawer: jest.fn(), toggleDrawer: jest.fn(), openDrawer: jest.fn() };
    const tree = renderLayout(390);
    const drawerContent = mockDrawerProps?.['drawerContent'] as (props: unknown) => ReactNode;
    act(() => tree.update(withAppStore(store, drawerContent({ navigation }))));

    expect(store.get(drawerCommandsAtom)?.navigationLabel).toBe('Open navigation drawer');
    act(() => store.get(drawerCommandsAtom)?.toggleNavigation?.());
    expect(navigation.toggleDrawer).toHaveBeenCalledTimes(1);
    expect(store.get(sidebarHiddenAtom)).toBe(false);

    act(() => tree.unmount());
  });
});
