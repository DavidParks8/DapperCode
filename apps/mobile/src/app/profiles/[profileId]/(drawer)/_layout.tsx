import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { Drawer, type DrawerContentComponentProps, useDrawerStatus } from 'expo-router/drawer';
import { router, usePathname } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Keyboard } from 'react-native';

import type { ShellLayout } from '@shell/layout/windowLayout';
import { useShellLayout } from '@shell/layout/useShellLayout';
import { DrawerContent } from '@shell/navigation/DrawerContent';
import { useDrawerForegroundSync } from '@shell/navigation/useDrawerForegroundSync';
import { sidebarHiddenAtom } from '@shell/state/appState/settings';
import { activeProfileIdAtom, apiClientAtom, wsClientAtom } from '@shell/state/bridge/atoms';
import { drawerCommandsAtom, OPEN_NAVIGATION_LABEL } from '@shell/state/drawer/atoms';
import { useAppTheme } from '@shared/theme';
import { routes } from '@shell/navigation/routes';
import { useKeyboardFocusBlocker } from '@shell/state/keyboard';

export const unstable_settings = {
  anchor: 'chats/[chatId]',
};

export default function DrawerLayout() {
  const layout = useShellLayout();
  return <ResponsiveDrawerLayout layout={layout} />;
}

export function ResponsiveDrawerLayout({ layout }: { layout: ShellLayout }) {
  const theme = useAppTheme();
  const { sidebarMode } = layout;

  return (
    <Drawer
      backBehavior="history"
      drawerContent={(props) => <RouterDrawerContent {...props} sidebarMode={sidebarMode} />}
      screenOptions={{
        headerShown: false,
        drawerType: sidebarMode === 'docked' ? 'permanent' : 'front',
        // A collapsed sidebar is re-docked by its toggle, never dragged in over the chat.
        swipeEnabled: sidebarMode === 'overlay',
        drawerStyle: {
          width: layout.sidebarWidth,
          backgroundColor: theme.colors.transparent,
        },
        overlayColor: theme.colors.transparent,
        sceneStyle: { backgroundColor: theme.colors.bgMain },
      }}
    />
  );
}

function RouterDrawerContent({
  navigation,
  sidebarMode,
}: DrawerContentComponentProps & { sidebarMode: ShellLayout['sidebarMode'] }) {
  const drawerStatus = useDrawerStatus();
  const coversChat = sidebarMode === 'overlay' && drawerStatus === 'open';
  useKeyboardFocusBlocker(coversChat);
  // The keyboard would hide the bottom of the session list, as it does in laptop pose.
  useEffect(() => {
    if (coversChat) {
      Keyboard.dismiss();
    }
  }, [coversChat]);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const api = useAtomValue(apiClientAtom);
  const ws = useAtomValue(wsClientAtom);
  const hasClients = Boolean(api && ws);
  const setDrawerCommands = useSetAtom(drawerCommandsAtom);
  const store = useStore();
  const docked = sidebarMode === 'docked';
  const pathname = usePathname();
  const pendingNewChat = useRef<{ profileId: string; pathname: string } | null>(null);
  const closeDrawer = useCallback(() => {
    pendingNewChat.current = null;
    navigation.closeDrawer();
  }, [navigation]);
  const navigateToNewChatKeepingDrawerOpen = useCallback(
    (profileId: string): boolean => {
      if (profileId !== activeProfileId) {
        return false;
      }
      const target = `/profiles/${encodeURIComponent(profileId)}/chats/new`;
      if (pathname === target) {
        pendingNewChat.current = null;
        navigation.openDrawer();
        return true;
      }
      if (pendingNewChat.current?.pathname !== target) {
        pendingNewChat.current = { profileId, pathname: target };
        router.navigate(routes.newChat(profileId));
      }
      return true;
    },
    [activeProfileId, navigation, pathname],
  );
  useDrawerForegroundSync(sidebarMode === 'overlay' ? navigation : null, drawerStatus);

  useEffect(() => {
    const pending = pendingNewChat.current;
    if (!pending) {
      return;
    }
    if (pending.profileId !== activeProfileId || sidebarMode !== 'overlay') {
      pendingNewChat.current = null;
      return;
    }
    // Navigating closes an overlay drawer; restore it only after the intended route is active.
    if (pathname === pending.pathname) {
      pendingNewChat.current = null;
      navigation.openDrawer();
    }
  }, [activeProfileId, navigation, pathname, sidebarMode]);

  useEffect(() => {
    if (sidebarMode === 'collapsed' && drawerStatus === 'open') {
      navigation.closeDrawer();
    }
  }, [drawerStatus, navigation, sidebarMode]);

  useLayoutEffect(() => {
    setDrawerCommands(
      sidebarMode === 'overlay'
        ? {
            closeDrawer,
            navigateToNewChatKeepingDrawerOpen,
            toggleNavigation: () => {
              pendingNewChat.current = null;
              navigation.toggleDrawer();
            },
            navigationLabel: OPEN_NAVIGATION_LABEL,
          }
        : {
            closeDrawer,
            toggleNavigation: () => store.set(sidebarHiddenAtom, !store.get(sidebarHiddenAtom)),
            navigationLabel: docked ? 'Hide sidebar' : 'Show sidebar',
          },
    );
    return () => setDrawerCommands(null);
  }, [
    closeDrawer,
    docked,
    navigateToNewChatKeepingDrawerOpen,
    navigation,
    setDrawerCommands,
    sidebarMode,
    store,
  ]);

  // The local profile's clients appear only once its runtime has started; bridge clients exist
  // synchronously. The drawer needs both, so it waits instead of rendering without a client.
  if (!hasClients) {
    return null;
  }
  return (
    <DrawerContent
      key={activeProfileId}
      active={docked || drawerStatus === 'open'}
      onClose={docked ? undefined : closeDrawer}
    />
  );
}
