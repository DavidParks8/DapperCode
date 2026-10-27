import { useAtomValue, useSetAtom } from 'jotai';

import { SceneVerticalToolbar, type SceneToolbarItem } from '@shell/layout/SceneToolbar';
import type { DrawerContentViewProps } from '@shell/navigation/DrawerContentView';
import { useDrawerContentAtoms } from '@shell/navigation/drawerContentViewContext';

export function DrawerToolbar({
  handleClose,
  handleNewChat,
  handleNavigate,
}: Pick<DrawerContentViewProps, 'handleClose' | 'handleNewChat' | 'handleNavigate'>) {
  const atoms = useDrawerContentAtoms();
  const { hasAnySessions, selectionMode } = useAtomValue(atoms.selectionButtonStateAtom);
  const enterSelectionMode = useSetAtom(atoms.enterSelectionModeAtom);
  const exitSelectionMode = useSetAtom(atoms.exitSelectionModeAtom);
  const items: SceneToolbarItem[] = [];

  if (selectionMode) {
    items.push({
      key: 'cancel-selection',
      icon: 'close',
      label: 'Cancel selecting sessions',
      onPress: exitSelectionMode,
      group: 'navigation',
    });
  } else {
    if (handleClose) {
      items.push({
        key: 'close',
        icon: 'chevron-forward',
        label: 'Close session list',
        onPress: handleClose,
        group: 'navigation',
      });
    }
    if (hasAnySessions) {
      items.push({
        key: 'select',
        icon: 'checkmark-circle-outline',
        label: 'Select sessions',
        onPress: enterSelectionMode,
        group: 'action',
      });
    }
    items.push(
      {
        key: 'new-chat',
        icon: 'add',
        label: 'New chat',
        onPress: handleNewChat,
        group: 'action',
        priority: 1,
      },
      {
        key: 'settings',
        icon: 'settings-outline',
        label: 'Open settings',
        onPress: () => handleNavigate('Settings'),
        group: 'bottom',
      },
    );
  }

  return <SceneVerticalToolbar items={items} />;
}
