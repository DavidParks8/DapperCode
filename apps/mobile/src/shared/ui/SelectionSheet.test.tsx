import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { requireTestValue } from '@shared/testing/requireTestValue';
import { AppThemeProvider, createAppTheme, spacing } from '@shared/theme';
import { SelectionSheet, type SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { MIN_TOUCH_TARGET, SHEET_CORNER_CLEARANCE } from '@shared/ui/sheetLayout';

jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Ionicons: ({ name }: { name: string }) => mockReact.createElement(MockText, null, name),
  };
});

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
  findByType(type: React.ElementType): QueryableInstance;
};

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(node: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <AppThemeProvider theme={theme}>{node}</AppThemeProvider>
    </SafeAreaProvider>
  );
}

function render(node: React.ReactNode): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(wrap(node));
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function textContent(node: QueryableInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function findPressable(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props['onPress'] === 'function' && node.props['accessibilityLabel'] === label,
  )[0];
  if (!match) {
    throw new Error(`Missing pressable: ${label}`);
  }
  return match;
}

function invokeStyle(node: QueryableInstance, pressed: boolean): unknown {
  const style = node.props['style'];
  return typeof style === 'function' ? style({ pressed }) : style;
}

function flattenStyle(style: unknown): Record<string, number | string | undefined> {
  return StyleSheet.flatten(style as never) ?? {};
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') {
    throw new Error(`Missing callback: ${name}`);
  }
  return callback(...args);
}

describe('SelectionSheet', () => {
  it('renders and invokes populated SelectionSheet option variants', () => {
    const onClose = jest.fn();
    const optionPresses = [jest.fn(), jest.fn(), jest.fn()];
    const options: SelectionSheetOption[] = [
      {
        key: 'selected',
        title: 'Selected',
        description: 'Current choice',
        badge: 'Active',
        meta: 'Default',
        icon: 'checkmark',
        selected: true,
        tone: 'accent',
        descriptionNumberOfLines: 4,
        titleColor: '#101010',
        descriptionColor: '#202020',
        titleStyle: { fontWeight: '700' },
        descriptionStyle: { fontStyle: 'italic' },
        badgeBackgroundColor: '#303030',
        badgeTextColor: '#fff',
        metaColor: '#404040',
        iconColor: '#505050',
        onPress: requireTestValue(optionPresses[0], 'selected option handler'),
      },
      {
        key: 'danger',
        title: 'Delete',
        description: 'Cannot be undone',
        icon: 'trash-outline',
        tone: 'danger',
        disabled: true,
        onPress: requireTestValue(optionPresses[1], 'danger option handler'),
      },
      {
        key: 'plain',
        title: 'Plain',
        onPress: requireTestValue(optionPresses[2], 'plain option handler'),
      },
    ];
    const tree = render(
      <SelectionSheet
        visible
        title="Choose one"
        subtitle="Available choices"
        eyebrow="Workspace"
        options={options}
        onClose={onClose}
        closeLabel="Done"
        presentation="expanded"
      />,
    );
    const root = queryRoot(tree);
    const selected = findPressable(root, 'Selected');
    const danger = findPressable(root, 'Delete');
    const plain = findPressable(root, 'Plain');
    expect(selected.props['accessibilityState']).toEqual({ disabled: false, selected: true });
    expect(danger.props['accessibilityState']).toEqual({ disabled: true });
    expect(invokeStyle(selected, true)).toBeDefined();
    expect(invokeStyle(danger, true)).toBeDefined();
    expect(invokeStyle(plain, false)).toBeDefined();
    act(() => invokeProp(selected, 'onPress'));
    expect(optionPresses[0]).toHaveBeenCalled();
    act(() => invokeProp(findPressable(root, 'Done'), 'onPress'));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('keeps the eyebrow and badge text readable at theme.typography.metadata size', () => {
    const onClose = jest.fn();
    const tree = render(
      <SelectionSheet
        visible
        title="Choose one"
        eyebrow="Workspace"
        options={[{ key: 'selected', title: 'Selected', badge: 'Active', onPress: jest.fn() }]}
        onClose={onClose}
        presentation="expanded"
      />,
    );
    const root = queryRoot(tree);

    const eyebrowText = root.findAll(
      (node) => node.type === Text && textContent(node) === 'Workspace',
    )[0];
    if (!eyebrowText) {
      throw new Error('Missing eyebrow text');
    }
    const eyebrowStyle = flattenStyle(eyebrowText.props['style']);
    const badgeText = root.findAll(
      (node) => node.type === Text && textContent(node) === 'Active',
    )[0];
    if (!badgeText) {
      throw new Error('Missing badge text');
    }
    const badgeTextStyle = flattenStyle(badgeText.props['style']);

    // Both styles must adopt theme.typography.metadata (11/14) instead of the old sub-11pt
    // literal override (10/12), while keeping their uppercase/bold/muted presentation.
    for (const style of [eyebrowStyle, badgeTextStyle]) {
      expect(Number(style['fontSize'])).toBe(11);
      expect(Number(style['lineHeight'])).toBe(14);
      expect(style['fontWeight']).toBe('700');
      expect(style['textTransform']).toBe('uppercase');
      expect(style['color']).toBe(theme.colors.textMuted);
    }

    act(() => tree.unmount());
  });

  it('renders SelectionSheet loading, empty, hidden, and default presentations', () => {
    const onClose = jest.fn();
    const tree = render(
      <SelectionSheet visible title="Loading sheet" options={[]} onClose={onClose} loading />,
    );
    expect(textContent(queryRoot(tree))).toContain('Loading…');
    act(() => {
      tree.update(
        wrap(
          <SelectionSheet
            visible
            title="Empty sheet"
            subtitle="Nothing here"
            options={[]}
            onClose={onClose}
            loadingLabel="Fetching choices"
            emptyLabel="No choices"
            presentation="default"
          />,
        ),
      );
    });
    expect(textContent(queryRoot(tree))).toContain('No choices');
    act(() => {
      tree.update(
        wrap(<SelectionSheet visible={false} title="Hidden" options={[]} onClose={onClose} />),
      );
    });
    expect(textContent(queryRoot(tree))).not.toContain('Hidden');
    act(() => tree.unmount());
  });

  it('keeps the close button out of the display corner and on a full touch target', () => {
    const onClose = jest.fn();
    const tree = render(
      <SelectionSheet
        visible
        title="Choose a model"
        subtitle="Choose the model for this session."
        options={[{ key: 'a', title: 'Model A', onPress: jest.fn() }]}
        onClose={onClose}
        presentation="expanded"
      />,
    );
    const root = queryRoot(tree);

    const footer = root.findAll((node) => node.props['testID'] === 'selection-sheet-footer')[0];
    if (!footer) {
      throw new Error('Missing selection sheet footer');
    }
    const footerStyle = flattenStyle(footer.props['style']);
    // Right aligning the button parked it in the screen's rounded bottom corner, where it was
    // visually clipped.
    expect(footerStyle['alignItems']).toBe('center');
    expect(footerStyle['alignItems']).not.toBe('flex-end');

    const close = findPressable(root, 'Close');
    const closeStyle = flattenStyle(invokeStyle(close, false));
    expect(Number(closeStyle['minHeight'] ?? 0)).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(closeStyle['alignSelf']).not.toBe('flex-end');

    const pressedStyle = flattenStyle(invokeStyle(close, true));
    expect(Number(pressedStyle['minHeight'] ?? 0)).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(pressedStyle['alignItems']).toBe('center');

    act(() => invokeProp(close, 'onPress'));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('leaves room below the close button even when the device reports no bottom inset', () => {
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: safeAreaMetrics.frame,
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <SelectionSheet
              visible
              title="Choose a model"
              options={[{ key: 'a', title: 'Model A', onPress: jest.fn() }]}
              onClose={onClose}
              presentation="expanded"
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
    });
    if (!tree) {
      throw new Error('Component did not render');
    }
    const content = queryRoot(tree).findAll(
      (node) => node.props['testID'] === 'app-sheet-content',
    )[0];
    if (!content) {
      throw new Error('Missing sheet content');
    }
    const contentStyle = flattenStyle(content.props['style']);
    expect(Number(contentStyle['paddingBottom'] ?? 0)).toBeGreaterThanOrEqual(
      SHEET_CORNER_CLEARANCE + spacing.lg,
    );
    act(() => tree?.unmount());
  });
});
