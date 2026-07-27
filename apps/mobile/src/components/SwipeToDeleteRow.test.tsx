import { Pressable, StyleSheet, Text } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { SWIPE_ACTION_WIDTH, SwipeToDeleteRow } from './SwipeToDeleteRow';

jest.mock('react-native-reanimated', () => jest.requireActual('../testing/reanimatedMock'));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('../testing/gestureHandlerMock'),
);

import { latestMockGesture, resetMockGestures, simulatePan } from '../testing/gestureHandlerMock';
import { mockSharedValues, resetMockSharedValues } from '../testing/reanimatedMock';

const ROW_WIDTH = 300;
const theme = createAppTheme('dark');

type Queryable = Omit<ReactTestInstance, 'props' | 'findAll'> & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

interface RenderedRow {
  tree: ReactTestRenderer;
  translateX: () => number;
}

function renderRow(onDelete: () => void | Promise<boolean | void>): RenderedRow {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <SwipeToDeleteRow deleteAccessibilityLabel="Delete Session one" onDelete={onDelete}>
          <Pressable accessibilityLabel="Open Session one">
            <Text>Session one</Text>
          </Pressable>
        </SwipeToDeleteRow>
      </AppThemeProvider>,
    );
  });
  const [translateXValue] = mockSharedValues;
  act(() => {
    const layoutNode = (tree.root as Queryable).findAll(
      (node) => typeof node.props.onLayout === 'function',
    )[0];
    (layoutNode.props.onLayout as (event: unknown) => void)({
      nativeEvent: { layout: { width: ROW_WIDTH, height: 68 } },
    });
  });
  return { tree, translateX: () => translateXValue.value as number };
}

function pressDelete(tree: ReactTestRenderer): void {
  act(() => {
    const action = (tree.root as Queryable).findAll(
      (node) =>
        node.props.accessibilityLabel === 'Delete Session one' &&
        typeof node.props.onPress === 'function',
    )[0];
    (action.props.onPress as () => void)();
  });
}

describe('SwipeToDeleteRow', () => {
  beforeEach(() => {
    resetMockGestures();
    resetMockSharedValues();
  });

  it('deletes when the revealed action is pressed', () => {
    const onDelete = jest.fn();
    const { tree } = renderRow(onDelete);

    pressDelete(tree);

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps the destructive layer behind an opaque native clipping surface', () => {
    const { tree } = renderRow(jest.fn());
    const clip = tree.root.findByProps({ testID: 'swipe-delete-clip' });
    const actionLayer = tree.root.findByProps({ testID: 'swipe-delete-action-layer' });
    const content = tree.root.findByProps({ testID: 'swipe-delete-content' });
    const clipStyle = StyleSheet.flatten(clip.props.style);
    const actionStyle = StyleSheet.flatten(actionLayer.props.style);
    const contentStyle = StyleSheet.flatten(content.props.style);

    expect(clip.props.collapsable).toBe(false);
    expect(clipStyle).toMatchObject({
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: theme.colors.bgMain,
    });
    expect(actionStyle).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      zIndex: 0,
      backgroundColor: theme.colors.error,
    });
    expect(contentStyle).toMatchObject({
      zIndex: 1,
      backgroundColor: theme.colors.bgMain,
    });
  });

  it('lets right drags through while closed so the drawer keeps its own swipe', () => {
    renderRow(jest.fn());

    expect(latestMockGesture('Pan').config.activeOffsetX).toBe(-6);
  });

  it('commits the delete when the row is dragged most of the way across', () => {
    const onDelete = jest.fn();
    const { translateX } = renderRow(onDelete);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -40 }, { translationX: -220 }]);
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(translateX()).toBe(-ROW_WIDTH);
  });

  it('never drags past the row or back beyond its resting position', () => {
    const { translateX } = renderRow(jest.fn());

    act(() => {
      latestMockGesture('Pan').onStart?.({});
      latestMockGesture('Pan').onUpdate?.({ translationX: 120 });
    });
    expect(translateX()).toBe(0);

    act(() => {
      latestMockGesture('Pan').onUpdate?.({ translationX: -900 });
    });
    expect(translateX()).toBe(-ROW_WIDTH);
  });

  it('parks the row open on a short drag and accepts drags in both directions once open', () => {
    const onDelete = jest.fn();
    const { translateX } = renderRow(onDelete);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -20 }, { translationX: -70 }], {
        velocityX: 0,
      });
    });

    expect(onDelete).not.toHaveBeenCalled();
    expect(translateX()).toBe(-SWIPE_ACTION_WIDTH);
    expect(latestMockGesture('Pan').config.activeOffsetX).toEqual([-6, 6]);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: 80 }], { velocityX: 0 });
    });

    expect(translateX()).toBe(0);
    expect(latestMockGesture('Pan').config.activeOffsetX).toBe(-6);
  });

  it('snaps the row back when a flick is too short to reveal the action', () => {
    const onDelete = jest.fn();
    const { translateX } = renderRow(onDelete);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -12 }], { velocityX: -100 });
    });

    expect(onDelete).not.toHaveBeenCalled();
    expect(translateX()).toBe(0);
  });

  it('opens on a fast flick even when the drag is short', () => {
    const { translateX } = renderRow(jest.fn());

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -12 }], { velocityX: -900 });
    });

    expect(translateX()).toBe(-SWIPE_ACTION_WIDTH);
  });

  it('springs the row back when the delete is declined', async () => {
    const onDelete = jest.fn().mockResolvedValue(false);
    const { translateX } = renderRow(onDelete);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -220 }]);
    });
    expect(translateX()).toBe(-ROW_WIDTH);

    await act(async () => {
      await Promise.resolve();
    });

    expect(translateX()).toBe(0);
  });

  it('keeps the row swiped away when the delete succeeds', async () => {
    const onDelete = jest.fn().mockResolvedValue(true);
    const { translateX } = renderRow(onDelete);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -220 }]);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(translateX()).toBe(-ROW_WIDTH);
  });

  it('springs the row back when the delete rejects', async () => {
    const onDelete = jest.fn().mockRejectedValue(new Error('nope'));
    const { tree, translateX } = renderRow(onDelete);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -70 }], { velocityX: 0 });
    });
    expect(translateX()).toBe(-SWIPE_ACTION_WIDTH);

    pressDelete(tree);
    await act(async () => {
      await Promise.resolve();
    });

    expect(translateX()).toBe(0);
  });

  it('springs the row back when the delete throws synchronously', () => {
    const onDelete = jest.fn(() => {
      throw new Error('nope');
    });
    const { tree, translateX } = renderRow(onDelete);

    act(() => {
      simulatePan(latestMockGesture('Pan'), [{ translationX: -70 }], { velocityX: 0 });
    });
    pressDelete(tree);

    expect(translateX()).toBe(0);
  });

  it('turns the gesture off when swiping is disabled', () => {
    act(() => {
      renderer.create(
        <AppThemeProvider theme={theme}>
          <SwipeToDeleteRow
            deleteAccessibilityLabel="Delete Session one"
            enabled={false}
            onDelete={jest.fn()}
          >
            <Text>Session one</Text>
          </SwipeToDeleteRow>
        </AppThemeProvider>,
      );
    });

    expect(latestMockGesture('Pan').config.enabled).toBe(false);
  });
});
