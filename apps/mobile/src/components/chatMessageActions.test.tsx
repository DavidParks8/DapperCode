import React from 'react';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { MessageActions } from './chatMessageActions';

jest.mock('expo-clipboard', () => ({
  __esModule: true,
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

const mockClipboard = Clipboard as unknown as { setStringAsync: jest.Mock };
const mockHaptics = Haptics as unknown as { notificationAsync: jest.Mock };

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

const theme = createAppTheme('dark');

function wrap(node: React.ReactNode) {
  return <AppThemeProvider theme={theme}>{node}</AppThemeProvider>;
}

function render(node: React.ReactNode): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(wrap(node));
  });
  if (!tree) throw new Error('Component did not render');
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function findPressable(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label,
  )[0];
  if (!match) throw new Error(`Missing pressable: ${label}`);
  return match;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') throw new Error(`Missing callback: ${name}`);
  return callback(...args);
}

describe('MessageActions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders nothing for blank text', () => {
    const tree = render(<MessageActions text="   " />);
    expect((tree as unknown as { toJSON(): unknown }).toJSON()).toBeNull();
  });

  it('copies the message, fires a success haptic, and shows a copied state', async () => {
    const tree = render(<MessageActions text="hello world" />);
    const root = queryRoot(tree);
    const copyButton = findPressable(root, 'Copy message');

    await act(async () => {
      invokeProp(copyButton, 'onPress');
      await Promise.resolve();
    });

    expect(mockClipboard.setStringAsync).toHaveBeenCalledWith('hello world');
    expect(mockHaptics.notificationAsync).toHaveBeenCalledWith('success');
    expect(findPressable(root, 'Copied message')).toBeDefined();
  });

  it('gives the copy and select buttons an effective touch target at or above the 44pt/48dp floor', () => {
    const tree = render(<MessageActions text="hello" onSelectText={() => {}} />);
    const root = queryRoot(tree);
    const copyButton = findPressable(root, 'Copy message');
    const selectButton = findPressable(root, 'Select message text');

    for (const button of [copyButton, selectButton]) {
      const hitSlop = button.props.hitSlop as
        { top: number; bottom: number; left: number; right: number } | undefined;
      expect(hitSlop).toBeDefined();
      expect(hitSlop!.top).toBeGreaterThan(0);
      expect(hitSlop!.bottom).toBeGreaterThan(0);
    }
  });

  it('omits the select-text action when no handler is provided', () => {
    const tree = render(<MessageActions text="hello" />);
    const root = queryRoot(tree);
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Select message text'),
    ).toHaveLength(0);
  });

  it('invokes onSelectText when the select action is pressed', () => {
    const onSelectText = jest.fn();
    const tree = render(<MessageActions text="hello" onSelectText={onSelectText} />);
    const root = queryRoot(tree);
    invokeProp(findPressable(root, 'Select message text'), 'onPress');
    expect(onSelectText).toHaveBeenCalledTimes(1);
  });
});
