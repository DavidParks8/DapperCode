import { Button, Menu } from '@expo/ui/swift-ui';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { queryRoot } from '@shared/testing/foldableLayout';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import type { SceneToolbarItem } from './SceneToolbar';
import { ToolbarOverflowMenu } from './ToolbarOverflowMenu.ios';

it('uses a native single-tap menu and dispatches the selected action without a custom sheet', () => {
  const onNewChat = jest.fn();
  const onRename = jest.fn();
  const items: SceneToolbarItem[] = [
    {
      key: 'rename',
      label: 'Edit session title',
      icon: 'pencil',
      group: 'action',
      onPress: onRename,
    },
    { key: 'new-chat', label: 'New chat', icon: 'add', group: 'action', onPress: onNewChat },
  ];
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={createAppTheme('light')}>
        <ToolbarOverflowMenu items={items} />
      </AppThemeProvider>,
    );
  });

  expect(tree.root.findByType(Menu).props['onPrimaryAction']).toBeUndefined();
  const root = queryRoot(tree);
  expect(root.findAll((node) => node.type === SelectionSheet)).toHaveLength(0);
  const actions = root.findAll((node) => node.type === Button);
  expect(actions.map((action) => action.props['label'])).toEqual([
    'Edit session title',
    'New chat',
  ]);
  const press = actions[1]?.props['onPress'];
  if (typeof press !== 'function') {
    throw new Error('Missing native new-chat menu action');
  }
  act(() => press());
  expect(onNewChat).toHaveBeenCalledTimes(1);
  expect(onRename).not.toHaveBeenCalled();
  act(() => tree.unmount());
});
