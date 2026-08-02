let mockDrawerProps: Record<string, unknown> | null = null;

jest.mock('expo-router/drawer', () => ({
  Drawer: (props: Record<string, unknown>) => {
    mockDrawerProps = props;
    return null;
  },
  useDrawerStatus: () => 'closed',
}));
jest.mock('./DrawerContent', () => ({ DrawerContent: () => null }));

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ResponsiveDrawerLayout } from '../app/profiles/[profileId]/(drawer)/_layout';
import { TABLET_SIDEBAR_WIDTH } from '../bootstrap/appConstants';

interface DrawerScreenOptions {
  drawerStyle: { width: number };
  drawerType: 'front' | 'permanent';
  sceneStyle: { backgroundColor: string };
  swipeEnabled: boolean;
}

function renderLayout(width: number): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<ResponsiveDrawerLayout width={width} />);
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

  it('fills a compact phone window, then becomes a push-aside sidebar when unfolded', () => {
    const tree = renderLayout(430);

    expect(readScreenOptions()).toMatchObject({
      drawerType: 'front',
      swipeEnabled: true,
      drawerStyle: { width: 430 },
      sceneStyle: { backgroundColor: '#000000' },
    });

    act(() => tree.update(<ResponsiveDrawerLayout width={1024} />));

    expect(readScreenOptions()).toMatchObject({
      drawerType: 'permanent',
      swipeEnabled: false,
      drawerStyle: { width: TABLET_SIDEBAR_WIDTH },
    });

    act(() => tree.unmount());
  });
});
