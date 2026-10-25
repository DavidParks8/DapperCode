import { Provider, createStore } from 'jotai';
import { Dimensions, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { queryRoot, type QueryNode } from '@shared/testing/foldableLayout';
import { CircularToolbarButton } from '@shared/ui/CircularToolbarButton';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { windowTraitsAtom } from '@shell/state/layout/atoms';
import {
  SceneToolbarHost,
  SceneVerticalToolbar,
  partitionToolbarItems,
  useInlineToolbar,
  type SceneToolbarItem,
} from './SceneToolbar';
import type { WindowTraits } from './windowLayout';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

type Queryable = QueryNode;

const theme = createAppTheme('dark');
const DUO_CLOSED: WindowTraits = {
  horizontalSizeClass: 'compact',
  verticalSizeClass: 'regular',
  verticalBarEdge: 'trailing',
  divisions: [],
  occlusions: [{ x: 382, y: 0, width: 84, height: 174 }],
  statusBar: null,
};

function item(
  key: string,
  group: SceneToolbarItem['group'],
  extra: Partial<SceneToolbarItem> = {},
): SceneToolbarItem {
  return { key, icon: 'ellipse', label: key, onPress: jest.fn(), group, ...extra };
}

let inline: boolean | null = null;
function InlineProbe() {
  inline = useInlineToolbar();
  return null;
}

function renderToolbar(
  traits: WindowTraits | null,
  items: readonly SceneToolbarItem[],
  window = { width: 466, height: 678 },
): ReactTestRenderer {
  act(() => {
    Dimensions.set({
      window: { ...window, scale: 3, fontScale: 1 },
      screen: { ...window, scale: 3, fontScale: 1 },
    });
  });
  const store = createStore();
  store.set(windowTraitsAtom, traits);
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, ...window },
          insets: { top: 0, left: 0, right: 84, bottom: 20 },
        }}
      >
        <Provider store={store}>
          <AppThemeProvider theme={theme}>
            <SceneToolbarHost items={items}>
              <InlineProbe />
            </SceneToolbarHost>
          </AppThemeProvider>
        </Provider>
      </SafeAreaProvider>,
    );
  });
  return tree;
}

function buttons(tree: ReactTestRenderer): Queryable[] {
  const bar = queryRoot(tree).findAll(
    (node) => node.props['testID'] === 'scene-vertical-toolbar' && typeof node.type !== 'string',
  )[0];
  if (!bar) {
    throw new Error('Expected the vertical toolbar');
  }
  return bar.findAll((node) => node.type === CircularToolbarButton);
}

describe('partitionToolbarItems', () => {
  const items = [
    item('menu', 'navigation'),
    item('rename', 'action'),
    item('git', 'action', { priority: 1 }),
    item('back', 'bottom'),
  ];

  it('keeps every item when they fit', () => {
    expect(partitionToolbarItems(items, 4).overflow).toEqual([]);
  });

  it('reserves a slot for the overflow button, keeps navigation, and honours priority', () => {
    const { visible, overflow } = partitionToolbarItems(items, 3);
    expect(visible.map(({ key }) => key)).toEqual(['menu', 'git']);
    expect(overflow.map(({ key }) => key)).toEqual(['rename', 'back']);
  });

  it('never moves navigation into the overflow menu, even without room', () => {
    expect(partitionToolbarItems(items, 0).visible.map(({ key }) => key)).toEqual(['menu']);
  });
});

describe('SceneVerticalToolbar', () => {
  afterEach(() => {
    inline = null;
    act(() => {
      Dimensions.set({
        window: { width: 750, height: 1334, scale: 2, fontScale: 1 },
        screen: { width: 750, height: 1334, scale: 2, fontScale: 1 },
      });
    });
  });

  it('renders nothing and leaves buttons inline while bars are horizontal', () => {
    const tree = renderToolbar(null, [item('menu', 'navigation')]);

    expect(inline).toBe(true);
    expect(
      queryRoot(tree).findAll((node) => node.props['testID'] === 'scene-vertical-toolbar'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('stacks navigation, actions, and bottom items in the bar column below the status bar', () => {
    const onBack = jest.fn();
    const tree = renderToolbar(DUO_CLOSED, [
      item('menu', 'navigation'),
      item('git', 'action', { disabled: true }),
      item('back', 'bottom', { onPress: onBack }),
    ]);

    expect(inline).toBe(false);
    const bar = queryRoot(tree).findAll(
      (node) => node.props['testID'] === 'scene-vertical-toolbar' && typeof node.type !== 'string',
    )[0];
    expect(StyleSheet.flatten(bar?.props['style'])).toMatchObject({
      position: 'absolute',
      top: 182,
      right: 0,
      width: 84,
      justifyContent: 'space-between',
    });
    expect(buttons(tree).map((button) => button.props['accessibilityLabel'])).toEqual([
      'menu',
      'git',
      'back',
    ]);
    expect(buttons(tree)[1]?.props['disabled']).toBe(true);
    act(() => (buttons(tree)[2]?.props['onPress'] as () => void)());
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('collapses lower-priority items into a standard overflow menu when the column is short', () => {
    const onRename = jest.fn();
    // Only two 48pt slots fit below the status column on this short window.
    const tree = renderToolbar(
      DUO_CLOSED,
      [
        item('menu', 'navigation'),
        item('rename', 'action', { onPress: onRename }),
        item('git', 'action'),
      ],
      { width: 466, height: 174 + 8 + 100 + 20 },
    );

    expect(buttons(tree).map((button) => button.props['accessibilityLabel'])).toEqual([
      'menu',
      'More',
    ]);
    act(() => (buttons(tree)[1]?.props['onPress'] as () => void)());
    const sheet = tree.root.findByType(SelectionSheet);
    expect(sheet.props['visible']).toBe(true);
    const options = sheet.props['options'] as { title: string; onPress: () => void }[];
    expect(options.map(({ title }) => title)).toEqual(['rename', 'git']);
    act(() => options[0]?.onPress());
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType(SelectionSheet).props['visible']).toBe(false);
    act(() => tree.unmount());
  });

  it('has no bar when the edge the system picks has no inset to hold it', () => {
    const tree = renderToolbar({ ...DUO_CLOSED, verticalBarEdge: 'leading', occlusions: [] }, [
      item('menu', 'navigation'),
    ]);

    expect(
      queryRoot(tree).findAll(
        (node) =>
          node.props['testID'] === 'scene-vertical-toolbar' && typeof node.type !== 'string',
      ),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });
});

describe('SceneVerticalToolbar without a host', () => {
  it('renders nothing when there are no items', () => {
    const store = createStore();
    store.set(windowTraitsAtom, DUO_CLOSED);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <Provider store={store}>
          <SceneVerticalToolbar items={[]} />
        </Provider>,
      );
    });
    expect(queryRoot(tree).findAll((node) => node.type === CircularToolbarButton)).toHaveLength(0);
    act(() => tree.unmount());
  });
});
