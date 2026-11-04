import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { Drawer, type DrawerContentComponentProps, useDrawerStatus } from 'expo-router/drawer';
import { useEffect } from 'react';

import type { ShellLayout } from '@shell/layout/windowLayout';
import { useShellLayout } from '@shell/layout/useShellLayout';
import { DrawerContent } from '@shell/navigation/DrawerContent';
import { useDrawerForegroundSync } from '@shell/navigation/useDrawerForegroundSync';
import { sidebarHiddenAtom } from '@shell/state/appState/settings';
import { activeProfileIdAtom, apiClientAtom, wsClientAtom } from '@shell/state/bridge/atoms';
import { drawerCommandsAtom, OPEN_NAVIGATION_LABEL } from '@shell/state/drawer/atoms';
import { useAppTheme } from '@shared/theme';

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
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const api = useAtomValue(apiClientAtom);
  const ws = useAtomValue(wsClientAtom);
  const hasClients = Boolean(api && ws);
  const setDrawerCommands = useSetAtom(drawerCommandsAtom);
  const store = useStore();
  const docked = sidebarMode === 'docked';
  useDrawerForegroundSync(sidebarMode === 'overlay' ? navigation : null, drawerStatus);

  useEffect(() => {
    if (sidebarMode === 'collapsed' && drawerStatus === 'open') {
      navigation.closeDrawer();
    }
  }, [drawerStatus, navigation, sidebarMode]);

  useEffect(() => {
    setDrawerCommands(
      sidebarMode === 'overlay'
        ? {
            closeDrawer: () => navigation.closeDrawer(),
            toggleNavigation: () => navigation.toggleDrawer(),
            navigationLabel: OPEN_NAVIGATION_LABEL,
          }
        : {
            closeDrawer: () => navigation.closeDrawer(),
            toggleNavigation: () => store.set(sidebarHiddenAtom, !store.get(sidebarHiddenAtom)),
            navigationLabel: docked ? 'Hide sidebar' : 'Show sidebar',
          },
    );
    return () => setDrawerCommands(null);
  }, [docked, navigation, setDrawerCommands, sidebarMode, store]);

  // The local profile's clients appear only once its runtime has started; bridge clients exist
  // synchronously. The drawer needs both, so it waits instead of rendering without a client.
  if (!hasClients) {
    return null;
  }
  return (
    <DrawerContent
      key={activeProfileId}
      active={docked || drawerStatus === 'open'}
      onClose={docked ? undefined : () => navigation.closeDrawer()}
    />
  );
}
