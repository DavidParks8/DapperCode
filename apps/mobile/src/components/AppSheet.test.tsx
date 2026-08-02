import { requireTestValue } from '../testing/requireTestValue';
import { Keyboard, StyleSheet, Text, type KeyboardEvent } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppSheet } from './AppSheet';
import {
  MIN_TOUCH_TARGET,
  SHEET_CORNER_CLEARANCE,
  SHEET_HANDLE_INDICATOR_WIDTH,
} from './sheetLayout';
import { AppThemeProvider, createAppTheme, spacing } from '../theme';

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

function wrapWithInsets(
  node: React.ReactNode,
  insets: { top: number; left: number; right: number; bottom: number },
) {
  return (
    <SafeAreaProvider initialMetrics={{ frame: safeAreaMetrics.frame, insets }}>
      <AppThemeProvider theme={theme}>{node}</AppThemeProvider>
    </SafeAreaProvider>
  );
}

type Queryable = Omit<ReactTestInstance, 'props' | 'findAll'> & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

type FlatStyle = Record<string, number | string | undefined>;

function flatten(style: unknown): FlatStyle {
  return StyleSheet.flatten(style as never) ?? {};
}

function findModal(tree: ReactTestRenderer): Queryable {
  const match = (tree.root as unknown as Queryable).findAll(
    (node) => typeof node.props['onDismiss'] === 'function',
  )[0];
  if (!match) {
    throw new Error('Expected a bottom sheet modal');
  }
  return match;
}

function findContentContainerStyle(tree: ReactTestRenderer): FlatStyle {
  const match = (tree.root as unknown as Queryable).findAll(
    (node) => node.props['testID'] === 'app-sheet-content',
  )[0];
  if (!match) {
    throw new Error('Expected sheet content');
  }
  return flatten(match.props['style']);
}

function renderBackdrop(tree: ReactTestRenderer): { props: Record<string, unknown> } {
  const backdropComponent = findModal(tree).props['backdropComponent'] as (
    props: Record<string, unknown>,
  ) => { props: Record<string, unknown> };
  return backdropComponent({ animatedIndex: { value: 0 }, animatedPosition: { value: 0 } });
}

function renderSheet(node: React.ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(node);
  });
  if (!tree) {
    throw new Error('Expected sheet tree');
  }
  return tree;
}

function textOf(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON() ?? null);
}

describe('AppSheet', () => {
  it('waits for an open keyboard to hide before presenting a sheet', () => {
    const isVisibleSpy = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    let handleKeyboardDidHide: ((event: KeyboardEvent) => void) | undefined;
    const remove = jest.fn();
    const listenerSpy = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, handler) => {
      if (event === 'keyboardDidHide') {
        handleKeyboardDidHide = handler;
      }
      return { remove } as unknown as ReturnType<typeof Keyboard.addListener>;
    });
    const tree = renderSheet(
      wrap(
        <AppSheet visible onClose={jest.fn()} accessibilityLabel="Choose a mode">
          <Text>Mode list</Text>
        </AppSheet>,
      ),
    );

    expect(dismissSpy).toHaveBeenCalledTimes(1);
    expect(textOf(tree)).not.toContain('Mode list');

    act(() => handleKeyboardDidHide?.({} as KeyboardEvent));

    expect(textOf(tree)).toContain('Mode list');

    act(() => tree.unmount());
    expect(remove).toHaveBeenCalledTimes(1);
    listenerSpy.mockRestore();
    dismissSpy.mockRestore();
    isVisibleSpy.mockRestore();
  });

  it('opens from an initially hidden state and can reopen after closing', () => {
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <AppSheet visible={false} onClose={onClose} accessibilityLabel="Picker">
            <Text>Sheet body</Text>
          </AppSheet>,
        ),
      );
    });
    if (!tree) {
      throw new Error('Expected sheet tree');
    }
    expect(textOf(tree)).not.toContain('Sheet body');

    act(() => {
      tree?.update(
        wrap(
          <AppSheet visible onClose={onClose} accessibilityLabel="Picker">
            <Text>Sheet body</Text>
          </AppSheet>,
        ),
      );
    });
    expect(textOf(tree)).toContain('Sheet body');
    expect(onClose).not.toHaveBeenCalled();

    // Closing through the `visible` prop must not echo back into onClose.
    act(() => {
      tree?.update(
        wrap(
          <AppSheet visible={false} onClose={onClose} accessibilityLabel="Picker">
            <Text>Sheet body</Text>
          </AppSheet>,
        ),
      );
    });
    expect(textOf(tree)).not.toContain('Sheet body');
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      tree?.update(
        wrap(
          <AppSheet visible onClose={onClose} accessibilityLabel="Picker">
            <Text>Sheet body</Text>
          </AppSheet>,
        ),
      );
    });
    expect(textOf(tree)).toContain('Sheet body');
    expect(onClose).not.toHaveBeenCalled();
    act(() => tree?.unmount());
  });

  it('reports a user dismissal once, and only while visible', () => {
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <AppSheet visible onClose={onClose} scrollable maxDynamicContentSize={400}>
            <Text>Scrollable body</Text>
          </AppSheet>,
        ),
      );
    });
    if (!tree) {
      throw new Error('Expected sheet tree');
    }
    expect(textOf(tree)).toContain('Scrollable body');

    const sheet = requireTestValue(
      (tree.root as unknown as Queryable).findAll(
        (node) => typeof node.props['onDismiss'] === 'function',
      )[0],
      'indexed test value',
    );
    act(() => (sheet.props['onDismiss'] as () => void)());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => tree?.unmount());
  });

  it('renders a non-dismissible sheet with fixed snap points', () => {
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <AppSheet
            visible
            onClose={onClose}
            dismissible={false}
            snapPoints={['50%']}
            contentBottomInset={12}
          >
            <Text>Locked body</Text>
          </AppSheet>,
        ),
      );
    });
    if (!tree) {
      throw new Error('Expected sheet tree');
    }
    expect(textOf(tree)).toContain('Locked body');
    act(() => tree?.unmount());
  });

  it('gives the drag handle a full touch target so drags never fall through to the content', () => {
    const tree = renderSheet(
      wrap(
        <AppSheet visible onClose={jest.fn()} accessibilityLabel="Choose a model" scrollable>
          <Text>Model list</Text>
        </AppSheet>,
      ),
    );

    const modal = findModal(tree);
    const handle = flatten(modal.props['handleStyle']);
    const indicator = flatten(modal.props['handleIndicatorStyle']);

    const paddingTop = Number(handle['paddingTop'] ?? 0);
    const paddingBottom = Number(handle['paddingBottom'] ?? 0);
    const indicatorHeight = Number(indicator['height'] ?? 0);

    expect(paddingTop).toBeGreaterThan(0);
    expect(paddingTop).toBe(paddingBottom);
    expect(indicatorHeight).toBeGreaterThan(0);
    expect(paddingTop + indicatorHeight + paddingBottom).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(Number(indicator['width'] ?? 0)).toBe(SHEET_HANDLE_INDICATOR_WIDTH);
    act(() => tree.unmount());
  });

  it('keeps the same handle target for a non scrollable sheet', () => {
    const tree = renderSheet(
      wrap(
        <AppSheet visible onClose={jest.fn()} accessibilityLabel="Menu">
          <Text>Menu body</Text>
        </AppSheet>,
      ),
    );

    const modal = findModal(tree);
    const handle = flatten(modal.props['handleStyle']);
    const indicator = flatten(modal.props['handleIndicatorStyle']);
    expect(
      Number(handle['paddingTop'] ?? 0) +
        Number(indicator['height'] ?? 0) +
        Number(handle['paddingBottom'] ?? 0),
    ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    act(() => tree.unmount());
  });

  it('pads scrollable content past the home indicator and the side insets', () => {
    const tree = renderSheet(
      wrapWithInsets(
        <AppSheet visible onClose={jest.fn()} accessibilityLabel="Choose a model" scrollable>
          <Text>Model list</Text>
        </AppSheet>,
        { top: 47, left: 44, right: 44, bottom: 34 },
      ),
    );

    const content = findContentContainerStyle(tree);
    expect(content['paddingBottom']).toBe(34 + spacing.lg);
    expect(content['paddingLeft']).toBe(44 + spacing.lg);
    expect(content['paddingRight']).toBe(44 + spacing.lg);
    act(() => tree.unmount());
  });

  it('keeps bottom aligned controls clear of the display corner when there is no bottom inset', () => {
    const tree = renderSheet(
      wrapWithInsets(
        <AppSheet visible onClose={jest.fn()} accessibilityLabel="Choose a model" scrollable>
          <Text>Model list</Text>
        </AppSheet>,
        { top: 0, left: 0, right: 0, bottom: 0 },
      ),
    );

    const content = findContentContainerStyle(tree);
    expect(content['paddingBottom']).toBe(SHEET_CORNER_CLEARANCE + spacing.lg);
    expect(Number(content['paddingBottom'])).toBeGreaterThan(spacing.lg);
    expect(content['paddingLeft']).toBe(spacing.lg);
    expect(content['paddingRight']).toBe(spacing.lg);
    act(() => tree.unmount());
  });

  it('applies the same edge insets to a non scrollable sheet, plus any extra inset', () => {
    const tree = renderSheet(
      wrapWithInsets(
        <AppSheet visible onClose={jest.fn()} accessibilityLabel="Menu" contentBottomInset={12}>
          <Text>Menu body</Text>
        </AppSheet>,
        { top: 0, left: 0, right: 0, bottom: 0 },
      ),
    );

    const content = findContentContainerStyle(tree);
    expect(content['paddingBottom']).toBe(SHEET_CORNER_CLEARANCE + spacing.lg + 12);
    expect(content['paddingLeft']).toBe(spacing.lg);
    expect(content['paddingRight']).toBe(spacing.lg);
    act(() => tree.unmount());
  });

  it('labels the backdrop for the sheet it closes and only closes when dismissible', () => {
    const dismissibleTree = renderSheet(
      wrap(
        <AppSheet visible onClose={jest.fn()} accessibilityLabel="Choose a model">
          <Text>Model list</Text>
        </AppSheet>,
      ),
    );
    const dismissibleBackdrop = renderBackdrop(dismissibleTree);
    expect(dismissibleBackdrop.props['pressBehavior']).toBe('close');
    expect(dismissibleBackdrop.props['accessibilityLabel']).toBe('Close Choose a model');
    act(() => dismissibleTree.unmount());

    const lockedTree = renderSheet(
      wrap(
        <AppSheet visible onClose={jest.fn()} dismissible={false}>
          <Text>Locked body</Text>
        </AppSheet>,
      ),
    );
    const lockedBackdrop = renderBackdrop(lockedTree);
    expect(lockedBackdrop.props['pressBehavior']).toBe('none');
    expect(lockedBackdrop.props['accessibilityLabel']).toBe('Close sheet');
    act(() => lockedTree.unmount());
  });

  it('keeps the handle target and edge insets in the light theme', () => {
    const lightTheme = createAppTheme('light');
    const tree = renderSheet(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <AppThemeProvider theme={lightTheme}>
          <AppSheet visible onClose={jest.fn()} accessibilityLabel="Choose a model" scrollable>
            <Text>Model list</Text>
          </AppSheet>
        </AppThemeProvider>
      </SafeAreaProvider>,
    );

    const modal = findModal(tree);
    const handle = flatten(modal.props['handleStyle']);
    const indicator = flatten(modal.props['handleIndicatorStyle']);
    expect(
      Number(handle['paddingTop'] ?? 0) +
        Number(indicator['height'] ?? 0) +
        Number(handle['paddingBottom'] ?? 0),
    ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(findContentContainerStyle(tree)['paddingBottom']).toBe(34 + spacing.lg);
    act(() => tree.unmount());
  });
});
