import { requireTestValue } from '@shared/testing/requireTestValue';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ChoiceAction, choiceActionAccessibilityLabel } from './ChoiceAction';

jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Ionicons: ({ name, ...props }: { name: string }) =>
      mockReact.createElement(MockText, { ...props, testID: `icon-${name}` }, name),
  };
});

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
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

function invokeStyle(node: QueryableInstance, pressed: boolean): unknown {
  const style = node.props['style'];
  return typeof style === 'function' ? style({ pressed }) : style;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') {
    throw new Error(`Missing callback: ${name}`);
  }
  return callback(...args);
}

describe('ChoiceAction', () => {
  it('renders and presses every ChoiceAction presentation', () => {
    const onPress = jest.fn();
    const tree = render(
      <>
        <ChoiceAction
          title="Primary"
          meta="Ready"
          variant="primary"
          logo="github"
          onPress={onPress}
        />
        <ChoiceAction title="Brand" logo="dappercode" onPress={onPress} />
        <ChoiceAction title="Icon" iconName="folder-outline" onPress={onPress} />
        <ChoiceAction title="Loading" loading onPress={onPress} />
        <ChoiceAction title="Disabled" disabled onPress={onPress} />
        <ChoiceAction title="Plain" onPress={onPress} />
      </>,
    );
    const buttons = queryRoot(tree).findAll(
      (node) =>
        typeof node.props['onPress'] === 'function' && typeof node.props['style'] === 'function',
    );
    expect(buttons).toHaveLength(6);
    expect(invokeStyle(requireTestValue(buttons[0], 'indexed test value'), true)).toBeDefined();
    expect(invokeStyle(requireTestValue(buttons[3], 'indexed test value'), true)).toBeDefined();
    expect(invokeStyle(requireTestValue(buttons[4], 'indexed test value'), false)).toBeDefined();
    act(() => invokeProp(requireTestValue(buttons[0], 'indexed test value'), 'onPress'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(textContent(queryRoot(tree))).toContain('Ready');
    act(() => tree.unmount());
  });

  it('exposes one labelled button with decorative icons and no empty spoken segments', () => {
    const tree = render(
      <>
        <ChoiceAction
          title="On this iPhone"
          meta="Offline models with file and Git tools"
          iconName="phone-portrait-outline"
          accessibilityHint="Opens a new chat that runs on this iPhone."
          testID="choice-local"
          onPress={jest.fn()}
        />
        <ChoiceAction title="Your machine" logo="dappercode" onPress={jest.fn()} />
        <ChoiceAction title="Loading" meta="  " loading onPress={jest.fn()} />
      </>,
    );
    const buttons = queryRoot(tree).findAll(
      (node) => typeof node.type === 'string' && node.props['accessibilityRole'] === 'button',
    );
    expect(buttons.map((button) => button.props['accessibilityLabel'])).toEqual([
      'On this iPhone, Offline models with file and Git tools',
      'Your machine',
      'Loading',
    ]);
    for (const button of buttons) {
      const label = String(button.props['accessibilityLabel']);
      expect(label.split(',').every((segment) => segment.trim().length > 0)).toBe(true);
    }
    const local = requireTestValue(buttons[0], 'local choice');
    expect(local.props['accessibilityHint']).toBe('Opens a new chat that runs on this iPhone.');
    expect(local.props['testID']).toBe('choice-local');
    expect(requireTestValue(buttons[2], 'loading choice').props['accessibilityState']).toEqual(
      expect.objectContaining({ disabled: true, busy: true }),
    );

    // Every glyph is hidden from assistive technology, either itself or through its container.
    const isGlyph = (node: QueryableInstance) =>
      typeof node.props['testID'] === 'string' && String(node.props['testID']).startsWith('icon-');
    const glyphs = queryRoot(tree).findAll(isGlyph);
    const hiddenGlyphs = new Set(
      queryRoot(tree)
        .findAll((node) => node.props['accessibilityElementsHidden'] === true)
        .flatMap((node) => node.findAll(isGlyph)),
    );
    expect(glyphs.length).toBeGreaterThanOrEqual(4);
    expect(glyphs.every((glyph) => hiddenGlyphs.has(glyph))).toBe(true);
    act(() => tree.unmount());
  });

  it('builds labels without empty segments', () => {
    expect(choiceActionAccessibilityLabel('Title', undefined)).toBe('Title');
    expect(choiceActionAccessibilityLabel('Title', '')).toBe('Title');
    expect(choiceActionAccessibilityLabel(' Title ', ' Meta ')).toBe('Title, Meta');
  });
});
