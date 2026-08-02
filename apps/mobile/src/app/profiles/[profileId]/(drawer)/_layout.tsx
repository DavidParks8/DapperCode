import { useAtomValue, useSetAtom } from 'jotai';
import { Drawer, type DrawerContentComponentProps, useDrawerStatus } from 'expo-router/drawer';
import { useEffect } from 'react';
import { useWindowDimensions } from 'react-native';

import { TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_WIDTH } from '@shell/boot/appConstants';
import { DrawerContent } from '@shell/navigation/DrawerContent';
import { activeBridgeProfileAtom } from '@shell/state/bridge/atoms';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { useAppTheme } from '@shared/theme';

export const unstable_settings = {
  anchor: 'chats/[chatId]',
};

export default function DrawerLayout() {
  const { width } = useWindowDimensions();
  return <ResponsiveDrawerLayout width={width} />;
}

export function ResponsiveDrawerLayout({ width }: { width: number }) {
  const theme = useAppTheme();
  const permanent = width >= TABLET_LAYOUT_MIN_WIDTH;

  return (
    <Drawer
      backBehavior="history"
      drawerContent={(props) => <RouterDrawerContent {...props} permanent={permanent} />}
      screenOptions={{
        headerShown: false,
        drawerType: permanent ? 'permanent' : 'front',
        swipeEnabled: !permanent,
        drawerStyle: { width: permanent ? TABLET_SIDEBAR_WIDTH : width },
        sceneStyle: { backgroundColor: theme.colors.bgMain },
      }}
    />
  );
}

function RouterDrawerContent({
  navigation,
  permanent,
}: DrawerContentComponentProps & { permanent: boolean }) {
  const drawerStatus = useDrawerStatus();
  const activeProfileId = useAtomValue(activeBridgeProfileAtom)?.id;
  const setDrawerCommands = useSetAtom(drawerCommandsAtom);

  useEffect(() => {
    setDrawerCommands({
      closeDrawer: () => navigation.closeDrawer(),
      toggleNavigation: permanent ? undefined : () => navigation.toggleDrawer(),
    });
    return () => setDrawerCommands(null);
  }, [navigation, permanent, setDrawerCommands]);

  return (
    <DrawerContent
      key={activeProfileId}
      active={permanent || drawerStatus === 'open'}
      onClose={permanent ? undefined : () => navigation.closeDrawer()}
    />
  );
}
