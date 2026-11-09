import { useAtomValue } from 'jotai';
import type { ComponentProps } from 'react';
import { Platform } from 'react-native';

import { SceneVerticalToolbar, type SceneToolbarItem } from '@shell/layout/SceneToolbar';
import { useTrailingActionRail } from '@shell/layout/useShellLayout';
import { useNavigationToggleLabel } from '@shell/state/drawer/atoms';
import { resolveComposerActionReach } from '../composer/inputLayout';
import { keyboardVisibleAtom } from '../state/composer';
import type { ChatHeader } from './ChatHeader';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

/** The chat header's buttons, laid out vertically when the system puts its bars on a side. */
export function ChatSceneToolbar({ context }: { context: Context }) {
  const {
    onOpenDrawer,
    selectedChat,
    openTitleEditor,
    handleOpenGit,
    shouldShowComposer,
    composerOverlayInset,
    composerSafeAreaBottomInset,
  } = context;
  const navigationLabel = useNavigationToggleLabel();
  const keyboardVisible = useAtomValue(keyboardVisibleAtom);
  // The composer's Send button sits at the bottom of a trailing bar, following the composer.
  const sendInRail = useTrailingActionRail() !== null && shouldShowComposer;
  const reservedBottom = sendInRail
    ? composerOverlayInset +
      resolveComposerActionReach(Platform.OS, composerSafeAreaBottomInset, keyboardVisible)
    : 0;
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
  return <SceneVerticalToolbar items={items} reservedBottom={reservedBottom} />;
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
