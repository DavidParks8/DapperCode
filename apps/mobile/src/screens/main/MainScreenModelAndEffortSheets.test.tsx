import { Provider, createStore } from 'jotai';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { MIN_TOUCH_TARGET, SHEET_CORNER_CLEARANCE } from '../../components/sheetLayout';
import { loadingModelsAtom } from '../../state/mainScreen/models';
import { effortModalVisibleAtom, modelModalVisibleAtom } from '../../state/mainScreen/modals';
import { AppThemeProvider, createAppTheme, spacing } from '../../theme';
import { MainScreenModelAndEffortSheets } from './MainScreenModelAndEffortSheets';

jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Ionicons: ({ name }: { name: string }) => mockReact.createElement(MockText, null, name),
  };
});

type Queryable = Omit<ReactTestInstance, 'props' | 'findAll'> & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

const theme = createAppTheme('dark');

function flattenStyle(style: unknown): Record<string, number | string | undefined> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;
}

function buildContext(closeModelModal: () => void, closeEffortModal: () => void) {
  return {
    activeModelLabel: 'Sonnet',
    closeEffortModal,
    closeModelModal,
    effortPickerSheetOptions: [{ key: 'high', title: 'High', onPress: jest.fn() }],
    modelPickerOptions: [
      { key: 'sonnet', title: 'Sonnet', selected: true, onPress: jest.fn() },
      { key: 'haiku', title: 'Haiku', onPress: jest.fn() },
    ],
  } as unknown as Parameters<typeof MainScreenModelAndEffortSheets>[0]['context'];
}

function openModelSelector(
  insets: { top: number; left: number; right: number; bottom: number },
  closeModelModal = jest.fn(),
): { tree: ReactTestRenderer; root: Queryable; closeModelModal: jest.Mock } {
  const store = createStore();
  store.set(modelModalVisibleAtom, true);
  store.set(effortModalVisibleAtom, false);
  store.set(loadingModelsAtom, false);

  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets }}>
        <AppThemeProvider theme={theme}>
          <Provider store={store}>
            <MainScreenModelAndEffortSheets context={buildContext(closeModelModal, jest.fn())} />
          </Provider>
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) throw new Error('Model selector did not render');
  return { tree, root: tree.root as unknown as Queryable, closeModelModal };
}

function findByTestId(root: Queryable, testID: string): Queryable {
  const match = root.findAll((node) => node.props.testID === testID)[0];
  if (!match) throw new Error(`Missing node: ${testID}`);
  return match;
}

describe('MainScreenModelAndEffortSheets', () => {
  it('places the model selector close button clear of the display corner', () => {
    const { tree, root, closeModelModal } = openModelSelector({
      top: 47,
      left: 0,
      right: 0,
      bottom: 34,
    });

    const footer = flattenStyle(findByTestId(root, 'selection-sheet-footer').props.style);
    expect(footer.alignItems).toBe('center');

    const close = findByTestId(root, 'selection-sheet-close');
    const closeStyle = flattenStyle(
      typeof close.props.style === 'function'
        ? (close.props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : close.props.style,
    );
    expect(Number(closeStyle.minHeight ?? 0)).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

    act(() => (close.props.onPress as () => void)());
    expect(closeModelModal).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('keeps the model selector padded below its close button on a device with no bottom inset', () => {
    const { tree, root } = openModelSelector({ top: 0, left: 0, right: 0, bottom: 0 });

    const content = root.findAll((node) => node.props.accessibilityViewIsModal === true)[0];
    if (!content) throw new Error('Missing model selector content');
    const contentStyle = flattenStyle(content.props.contentContainerStyle ?? content.props.style);
    expect(Number(contentStyle.paddingBottom ?? 0)).toBeGreaterThanOrEqual(
      SHEET_CORNER_CLEARANCE + spacing.lg,
    );
    act(() => tree.unmount());
  });

  it('gives the model selector drag handle a full touch target', () => {
    const { tree, root } = openModelSelector({ top: 47, left: 0, right: 0, bottom: 34 });

    const modal = root.findAll((node) => typeof node.props.onDismiss === 'function')[0];
    if (!modal) throw new Error('Missing model selector sheet');
    const handle = flattenStyle(modal.props.handleStyle);
    const indicator = flattenStyle(modal.props.handleIndicatorStyle);
    expect(
      Number(handle.paddingTop ?? 0) +
        Number(indicator.height ?? 0) +
        Number(handle.paddingBottom ?? 0),
    ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    act(() => tree.unmount());
  });

  it('shows the thinking level sheet instead when only that modal is open', () => {
    const store = createStore();
    store.set(modelModalVisibleAtom, false);
    store.set(effortModalVisibleAtom, true);
    store.set(loadingModelsAtom, true);
    const closeEffortModal = jest.fn();

    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <Provider store={store}>
              <MainScreenModelAndEffortSheets context={buildContext(jest.fn(), closeEffortModal)} />
            </Provider>
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
    });
    if (!tree) throw new Error('Effort sheet did not render');
    const effortTree = tree;
    const root = effortTree.root as unknown as Queryable;
    const close = findByTestId(root, 'selection-sheet-close');
    act(() => (close.props.onPress as () => void)());
    expect(closeEffortModal).toHaveBeenCalledTimes(1);
    act(() => effortTree.unmount());
  });
});
