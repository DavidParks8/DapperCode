let mockDrawerProps: Record<string, unknown> | null = null;

jest.mock('expo-router/drawer', () => ({
  Drawer: (props: Record<string, unknown>) => {
    mockDrawerProps = props;
    return null;
  },
  useDrawerStatus: () => 'closed',
}));
jest.mock('@shell/navigation/DrawerContent', () => ({ DrawerContent: () => null }));

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ResponsiveDrawerLayout } from '../../app/profiles/[profileId]/(drawer)/_layout';
import { TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_WIDTH } from '@shell/boot/appConstants';

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

    act(() => tree.update(<ResponsiveDrawerLayout width={1024} />));

    expect(readScreenOptions()).toMatchObject({
      drawerType: 'permanent',
      swipeEnabled: false,
      drawerStyle: { width: TABLET_SIDEBAR_WIDTH },
    });

    act(() => tree.unmount());
  });
});
