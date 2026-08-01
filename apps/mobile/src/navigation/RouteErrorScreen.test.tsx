jest.mock('expo-router', () => jest.requireActual('../testing/expoRouterMock'));

import { router } from 'expo-router';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { RouteErrorScreen } from './RouteErrorScreen';

type Queryable = ReactTestInstance & {
  findAll: (predicate: (node: Queryable) => boolean) => Queryable[];
};

describe('RouteErrorScreen', () => {
  it('shows recovery context and returns to the root route', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={createAppTheme('dark')}>
          <RouteErrorScreen title="Missing profile" message="Choose a saved bridge." />
        </AppThemeProvider>,
      );
    });
    if (!tree) throw new Error('Expected route error screen');
    const button = (tree.root as Queryable).findAll(
      (node) => node.props.accessibilityRole === 'button',
    )[0];
    act(() => (button.props.onPress as () => void)());
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree?.unmount());
  });
});
