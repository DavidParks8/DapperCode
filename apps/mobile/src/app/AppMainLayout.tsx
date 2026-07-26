import { useAtomValue } from 'jotai';
import { ActivityIndicator, Text, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { DrawerContent } from '../navigation/DrawerContent';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import { chatTransitionChatIdAtom, mainOpeningChatIdAtom } from '../state/chat/atoms';
import { currentScreenAtom } from '../state/navigation/atoms';
import { AppThemeProvider, type AppTheme } from '../theme';
import { TABLET_SIDEBAR_WIDTH } from './appConstants';
import { AppScreenRenderer } from './AppScreenRenderer';
import type { AppStyles } from './appStyles';
import type { useDrawerController } from './useDrawerController';

interface AppMainLayoutProps {
  theme: AppTheme;
  styles: AppStyles;
  usesTabletLayout: boolean;
  tabletLayoutTransition: unknown;
  screenWidth: number;
  drawerWidth: number;
  drawer: ReturnType<typeof useDrawerController>;
}

export function AppMainLayout({
  theme,
  styles,
  usesTabletLayout,
  tabletLayoutTransition,
  screenWidth,
  drawerWidth,
  drawer,
}: AppMainLayoutProps) {
  const activeBridgeProfile = useAtomValue(activeBridgeProfileAtom);
  const currentScreen = useAtomValue(currentScreenAtom);
  const chatTransitionChatId = useAtomValue(chatTransitionChatIdAtom);
  const mainOpeningChatId = useAtomValue(mainOpeningChatIdAtom);
  const drawerBlocksScreen = drawer.drawerVisible && drawer.drawerCapturesTouches;

  return (
    <AppThemeProvider theme={theme}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <View style={[styles.root, usesTabletLayout && styles.tabletShell]}>
            {usesTabletLayout ? (
              <Animated.View
                layout={tabletLayoutTransition as never}
                pointerEvents={drawer.tabletSidebarVisible ? 'auto' : 'none'}
                style={[
                  styles.tabletSidebarClip,
                  { width: drawer.tabletSidebarVisible ? TABLET_SIDEBAR_WIDTH : 0 },
                ]}
              >
                <View style={styles.tabletSidebarContent}>
                  <DrawerContent key={activeBridgeProfile?.id} active />
                </View>
              </Animated.View>
            ) : null}
            <GestureDetector gesture={drawer.openDrawerGesture as never}>
              <Animated.View
                layout={usesTabletLayout ? (tabletLayoutTransition as never) : undefined}
                pointerEvents={drawerBlocksScreen ? 'none' : 'auto'}
                accessibilityElementsHidden={drawerBlocksScreen}
                importantForAccessibility={drawerBlocksScreen ? 'no-hide-descendants' : 'auto'}
                style={[
                  styles.screenFrame,
                  usesTabletLayout && styles.tabletScreenFrame,
                  drawer.screenFrameAnimatedStyle,
                  usesTabletLayout ? null : { width: screenWidth },
                ]}
              >
                <GestureDetector gesture={drawer.backSwipeGesture as never}>
                  <View style={styles.screen}>
                    <AppScreenRenderer />
                    {chatTransitionChatId || (currentScreen === 'Main' && mainOpeningChatId) ? (
                      <View style={styles.chatTransitionOverlay}>
                        <View
                          style={styles.chatTransitionCard}
                          accessibilityRole="progressbar"
                          accessibilityLabel="Opening chat"
                          accessibilityLiveRegion="polite"
                        >
                          <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                          <Text style={styles.chatTransitionTitle}>Opening chat...</Text>
                        </View>
                      </View>
                    ) : null}
                  </View>
                </GestureDetector>
              </Animated.View>
            </GestureDetector>

            {!usesTabletLayout ? (
              <View
                pointerEvents={drawerBlocksScreen ? 'auto' : 'none'}
                style={styles.drawerLayer}
              >
                <GestureDetector gesture={drawer.visibleDrawerGesture as never}>
                  <View style={styles.drawerGestureSurface}>
                    <GestureDetector gesture={drawer.visibleDrawerTapGesture as never}>
                      <Animated.View style={[styles.overlay, drawer.overlayAnimatedStyle]} />
                    </GestureDetector>
                    <Animated.View
                      style={[styles.drawer, { width: drawerWidth }, drawer.drawerAnimatedStyle]}
                    >
                      <Animated.View
                        style={[styles.drawerContentShell, drawer.drawerContentAnimatedStyle]}
                        accessibilityViewIsModal={drawer.drawerVisible}
                        importantForAccessibility={drawer.drawerVisible ? 'yes' : 'auto'}
                      >
                        <DrawerContent
                          key={activeBridgeProfile?.id}
                          active={drawer.drawerVisible}
                          onClose={drawer.closeDrawer}
                        />
                      </Animated.View>
                    </Animated.View>
                  </View>
                </GestureDetector>
              </View>
            ) : null}
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </AppThemeProvider>
  );
}
