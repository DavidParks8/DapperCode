import { requireTestValue } from '@shared/testing/requireTestValue';
jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));

import { router } from 'expo-router';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { RouteErrorScreen } from '@shell/navigation/RouteErrorScreen';

type Queryable = Omit<ReactTestInstance, 'children' | 'findAll' | 'parent' | 'props'> & {
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  type: unknown;
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
    if (!tree) {
      throw new Error('Expected route error screen');
    }
    const button = requireTestValue(
      (tree.root as Queryable).findAll((node) => node.props['accessibilityRole'] === 'button')[0],
      'indexed test value',
    );
    act(() => (button.props['onPress'] as () => void)());
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree?.unmount());
  });

  it('uses semantic typography roles instead of ad hoc font sizes', () => {
    const theme = createAppTheme('dark');
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={theme}>
          <RouteErrorScreen title="Missing profile" message="Choose a saved bridge." />
        </AppThemeProvider>,
      );
    });
    if (!tree) {
      throw new Error('Expected route error screen');
    }
    const texts = (tree.root as Queryable).findAll((node) => node.type === Text);
    const titleText = requireTestValue(texts[0], 'route error title');
    const messageText = requireTestValue(texts[1], 'route error message');
    const actionText = requireTestValue(texts[2], 'route error action');

    const flatTitle = StyleSheet.flatten<TextStyle>(
      titleText.props['style'] as StyleProp<TextStyle>,
    );
    expect(flatTitle.fontSize).toBe(theme.typography.title.fontSize);
    expect(flatTitle.lineHeight).toBe(theme.typography.title.lineHeight);

    const flatMessage = StyleSheet.flatten<TextStyle>(
      messageText.props['style'] as StyleProp<TextStyle>,
    );
    expect(flatMessage.fontSize).toBe(theme.typography.body.fontSize);
    expect(flatMessage.lineHeight).toBe(theme.typography.body.lineHeight);

    const flatAction = StyleSheet.flatten<TextStyle>(
      actionText.props['style'] as StyleProp<TextStyle>,
    );
    expect(flatAction.fontSize).toBe(theme.typography.headline.fontSize);
    expect(flatAction.lineHeight).toBe(theme.typography.headline.lineHeight);
    expect(flatAction.fontWeight).toBe('700');

    act(() => tree?.unmount());
  });
});
