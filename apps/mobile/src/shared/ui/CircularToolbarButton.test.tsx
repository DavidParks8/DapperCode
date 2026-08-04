import { StyleSheet, Text } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  CIRCULAR_TOOLBAR_BUTTON_SIZE,
  CircularToolbarButton,
  resolveCircularToolbarButtonStyle,
} from '@shared/ui/CircularToolbarButton';

const theme = createAppTheme('dark');
type Queryable = Omit<ReactTestInstance, 'findAll' | 'props' | 'type'> & {
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

function findHostButton(tree: ReactTestRenderer): Queryable {
  const button = (tree.root as Queryable).findAll(
    (node) =>
      typeof node.type === 'string' && node.props['accessibilityLabel'] === 'Toolbar action',
  )[0];
  if (!button) {
    throw new Error('Expected native toolbar button');
  }
  return button;
}

function renderButton(disabled = false): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <CircularToolbarButton
          accessibilityLabel="Toolbar action"
          disabled={disabled}
          onPress={jest.fn()}
        >
          <Text>icon</Text>
        </CircularToolbarButton>
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected toolbar button');
  }
  return tree;
}

describe('CircularToolbarButton', () => {
  it('standardizes toolbar geometry and circular pressed feedback', () => {
    const tree = renderButton();
    const button = findHostButton(tree);

    expect(button.props['accessibilityRole']).toBe('button');
    expect(
      StyleSheet.flatten(
        resolveCircularToolbarButtonStyle(theme, { pressed: false, disabled: false }) as never,
      ),
    ).toMatchObject({
      width: CIRCULAR_TOOLBAR_BUTTON_SIZE,
      height: CIRCULAR_TOOLBAR_BUTTON_SIZE,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    });
    expect(
      StyleSheet.flatten(
        resolveCircularToolbarButtonStyle(theme, { pressed: true, disabled: false }) as never,
      ),
    ).toMatchObject({
      backgroundColor: theme.colors.bgCanvasAccent,
      borderRadius: theme.radius.full,
    });
    act(() => tree.unmount());
  });

  it('does not paint pressed feedback while disabled', () => {
    const tree = renderButton(true);
    const button = findHostButton(tree);
    const pressedStyle = StyleSheet.flatten(
      resolveCircularToolbarButtonStyle(theme, { pressed: true, disabled: true }) as never,
    );

    expect(button.props['accessibilityState']).toMatchObject({ disabled: true });
    expect(pressedStyle).toMatchObject({ opacity: 0.5 });
    expect(pressedStyle).not.toHaveProperty('backgroundColor');
    act(() => tree.unmount());
  });
});
