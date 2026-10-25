import type { ComponentProps } from 'react';

import { SceneVerticalToolbar, type SceneToolbarItem } from '@shell/layout/SceneToolbar';
import { useNavigationToggleLabel } from '@shell/state/drawer/atoms';
import type { ChatHeader } from './ChatHeader';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

/** The chat header's buttons, laid out vertically when the system puts its bars on a side. */
export function ChatSceneToolbar({ context }: { context: Context }) {
  const { onOpenDrawer, selectedChat, openTitleEditor, handleOpenGit } = context;
  const navigationLabel = useNavigationToggleLabel();
  const items: SceneToolbarItem[] = [];
  if (onOpenDrawer) {
    items.push({
      key: 'navigation',
      icon: 'menu',
      label: navigationLabel,
      onPress: onOpenDrawer,
      group: 'navigation',
    });
  }
  if (selectedChat) {
    items.push(
      {
        key: 'rename',
        icon: 'pencil',
        label: 'Edit session title',
        onPress: openTitleEditor,
        group: 'action',
      },
      {
        key: 'git',
        icon: 'git-branch-outline',
        label: 'Open Git',
        onPress: handleOpenGit,
        group: 'action',
        priority: 1,
      },
    );
  }
  return <SceneVerticalToolbar items={items} />;
}

/** The header shows its buttons only while bars are horizontal; otherwise the side bar does. */
export function resolveInlineHeaderButtons(
  inline: boolean,
  actions: {
    onOpenDrawer?: () => void;
    hasChat: boolean;
    openTitleEditor: () => void;
    handleOpenGit: () => void;
  },
): Pick<
  ComponentProps<typeof ChatHeader>,
  'onOpenDrawer' | 'onRenameTitle' | 'rightIconName' | 'onRightActionPress'
> {
  if (!inline) {
    return {};
  }
  return {
    onOpenDrawer: actions.onOpenDrawer,
    ...(actions.hasChat
      ? {
          onRenameTitle: actions.openTitleEditor,
          rightIconName: 'git-branch-outline',
          onRightActionPress: actions.handleOpenGit,
        }
      : {}),
  };
}
