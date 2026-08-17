import { StyleSheet, Text, View } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { requireTestValue } from '@shared/testing/requireTestValue';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from './SettingsList';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => name,
}));

const theme = createAppTheme('dark');

type Queryable = Omit<ReactTestInstance, 'children' | 'findAll' | 'props' | 'type'> & {
  children: unknown[];
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

function render(node: React.ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<AppThemeProvider theme={theme}>{node}</AppThemeProvider>);
  });
  if (!tree) {
    throw new Error('Expected rendered tree');
  }
  return tree;
}

function flattenStyle(node: Queryable): Record<string, unknown> {
  return StyleSheet.flatten(node.props['style'] as never) ?? {};
}

function findByText(root: Queryable, text: string): Queryable {
  const match = root.findAll((node) => node.children.map(String).join('') === text)[0];
  if (!match) {
    throw new Error(`Missing node: ${text}`);
  }
  return match;
}

function findSeparators(root: Queryable): Queryable[] {
  return root.findAll((node) => {
    if (node.type !== View) {
      return false;
    }
    const style = flattenStyle(node);
    return style['height'] === StyleSheet.hairlineWidth;
  });
}

describe('settings inset-grouped list', () => {
  it('paints one card per group and hairlines only between rows', () => {
    const tree = render(
      <SettingsGroup title="Connection" footer="Bridges live on your own machine.">
        <SettingsRow label="Primary" value="Connected" accessory="chevron" onPress={jest.fn()} />
        <SettingsRow label="Add bridge" tone="accent" accessory="chevron" onPress={jest.fn()} />
        <SettingsToggleRow label="Show tool calls" value onChange={jest.fn()} />
      </SettingsGroup>,
    );
    const root = tree.root as Queryable;

    const card = requireTestValue(
      root.findAll(
        (node) =>
          node.type === View && flattenStyle(node)['backgroundColor'] === theme.colors.bgItem,
      )[0],
      'grouped card',
    );
    const cardStyle = flattenStyle(card);
    expect(cardStyle['borderRadius']).toBe(theme.radius.md);
    expect(cardStyle['overflow']).toBe('hidden');

    // Three rows means two separators, and each one starts at the row label, not the card edge.
    const separators = findSeparators(root);
    expect(separators).toHaveLength(2);
    separators.forEach((separator) => {
      expect(flattenStyle(separator)['marginLeft']).toBe(16);
    });

    expect(flattenStyle(findByText(root, 'Connection'))['textTransform']).toBe('uppercase');
    expect(findByText(root, 'Bridges live on your own machine.')).toBeTruthy();
    act(() => tree.unmount());
  });

  it('honors a wider separator inset for icon rows', () => {
    const tree = render(
      <SettingsGroup title="Installed ACP agents" separatorInset={56}>
        <View>
          <Text>Codex</Text>
        </View>
        <View>
          <Text>Claude</Text>
        </View>
      </SettingsGroup>,
    );
    const separators = findSeparators(tree.root as Queryable);
    expect(separators).toHaveLength(1);
    expect(flattenStyle(separators[0] as Queryable)['marginLeft']).toBe(56);
    act(() => tree.unmount());
  });

  it('keeps rows at the platform touch target and speaks the selected bridge', () => {
    const tree = render(
      <SettingsGroup>
        <SettingsRow label="Primary" accessory="check" selected onPress={jest.fn()} />
        <SettingsRow label="Secondary" accessory="check" onPress={jest.fn()} />
      </SettingsGroup>,
    );
    const root = tree.root as Queryable;
    const [active, inactive] = root.findAll(
      (node) =>
        typeof node.type === 'string' && typeof node.props['accessibilityState'] === 'object',
    );

    expect(active?.props['accessibilityLabel']).toBe('Primary, Active');
    expect(active?.props['accessibilityState']).toMatchObject({ selected: true });
    expect(inactive?.props['accessibilityLabel']).toBe('Secondary');
    expect(inactive?.props['accessibilityState']).toMatchObject({ selected: false });

    const rowStyle = flattenStyle(active as Queryable);
    expect(rowStyle['minHeight']).toBe(theme.touchTarget.minimum);
    expect(rowStyle['backgroundColor']).toBe(theme.colors.bgItem);
    act(() => tree.unmount());
  });
});
