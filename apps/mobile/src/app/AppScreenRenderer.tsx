import { useAtomValue } from 'jotai';
import { useEffect, type ComponentProps, type ReactNode } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { env } from '../config';
import { BrowserScreen } from '../screens/browser/BrowserScreen';
import { GitCheckoutScreen } from '../screens/gitCheckout/GitCheckoutScreen';
import { GitScreen } from '../screens/git/GitScreen';
import { MainScreen } from '../screens/main/MainScreen';
import { PrivacyScreen } from '../screens/legal/PrivacyScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { TermsScreen } from '../screens/legal/TermsScreen';
import { WorkspacePickerScreen } from '../screens/workspacePicker/WorkspacePickerScreen';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import { gitChatAtom } from '../state/chat/atoms';
import { drawerCommandsAtom } from '../state/drawer/atoms';
import {
  currentScreenAtom,
  navigationStackAtom,
  type NavigationRoute,
} from '../state/navigation/atoms';

type AnimatedViewStyle = ComponentProps<typeof Animated.View>['style'];

interface AppScreenRendererProps {
  backSwipeUnderlayAnimatedStyle?: AnimatedViewStyle;
  backSwipePushedScreenAnimatedStyle?: AnimatedViewStyle;
}

/** Stable React key for a route so React preserves component state across re-renders. */
function routeKey(route: NavigationRoute): string {
  return route.screen === 'SubAgent' ? `SubAgent-${route.threadId}` : route.screen;
}

function useOpenDrawer(): () => void {
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  return () => drawerCommands?.toggleNavigation();
}

/**
 * Renders MainScreen as a persistent underlay with zero or more pushed routes on top.
 *
 * Only the topmost layer receives the drag transform; the layer directly below it receives the
 * parallax underlay shift.  All covered layers are removed from the accessibility tree and
 * pointer-event handling to match native stack behaviour.
 */
function ScreenStack({
  children,
  pushedRoutes,
  renderRoute,
  underlayAnimatedStyle,
  pushedScreenAnimatedStyle,
}: {
  children: ReactNode;
  pushedRoutes: readonly NavigationRoute[];
  renderRoute: (route: NavigationRoute) => ReactNode;
  underlayAnimatedStyle?: AnimatedViewStyle;
  pushedScreenAnimatedStyle?: AnimatedViewStyle;
}) {
  const hasPushed = pushedRoutes.length > 0;
  // Main gets the parallax shift only when it is the direct underlay (single pushed route).
  const mainUnderlayStyle = hasPushed && pushedRoutes.length === 1 ? underlayAnimatedStyle : undefined;

  return (
    <View style={styles.stack}>
      {/* Main — always mounted; covered when any route is pushed. */}
      <Animated.View
        style={[styles.stack, mainUnderlayStyle]}
        pointerEvents={hasPushed ? 'none' : 'auto'}
        accessibilityElementsHidden={hasPushed}
        importantForAccessibility={hasPushed ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </Animated.View>

      {/* Intermediate pushed routes (everything except the topmost). */}
      {pushedRoutes.slice(0, -1).map((route, index) => {
        const isDirectlyBelowTop = index === pushedRoutes.length - 2;
        return (
          <Animated.View
            key={routeKey(route)}
            style={[styles.pushedScreen, isDirectlyBelowTop ? underlayAnimatedStyle : undefined]}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {renderRoute(route)}
          </Animated.View>
        );
      })}

      {/* Topmost pushed route — receives the interactive drag transform. */}
      {hasPushed ? (
        <Animated.View
          key={routeKey(pushedRoutes[pushedRoutes.length - 1])}
          style={[styles.pushedScreen, pushedScreenAnimatedStyle]}
        >
          {renderRoute(pushedRoutes[pushedRoutes.length - 1])}
        </Animated.View>
      ) : null}
    </View>
  );
}

export function AppScreenRenderer({
  backSwipeUnderlayAnimatedStyle,
  backSwipePushedScreenAnimatedStyle,
}: AppScreenRendererProps = {}) {
  const currentScreen = useAtomValue(currentScreenAtom);
  const navigationStack = useAtomValue(navigationStackAtom);
  const gitChat = useAtomValue(gitChatAtom);
  const onOpenDrawer = useOpenDrawer();
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id;

  useEffect(() => {
    if (currentScreen === 'ChatGit' || currentScreen === 'SubAgent') {
      Keyboard.dismiss();
    }
  }, [currentScreen]);

  // MainScreen still owns per-profile session state, so it is remounted per bridge profile.
  const mainScreen = <MainScreen key={activeBridgeProfileId} />;

  // SubAgent content is rendered inline by MainScreen; exclude it from the visual push stack so
  // MainScreen remains interactive and accessible when SubAgent is the current route.
  const pushedRoutes = navigationStack.slice(1).filter((r) => r.screen !== 'SubAgent');

  function renderRoute(route: NavigationRoute): ReactNode {
    switch (route.screen) {
      case 'ChatGit':
        return gitChat ? <GitScreen chat={gitChat} /> : null;
      case 'WorkspacePicker':
        return <WorkspacePickerScreen />;
      case 'GitCheckout':
        return <GitCheckoutScreen />;
      case 'Settings':
        return <SettingsScreen />;
      case 'Browser':
        return <BrowserScreen />;
      case 'Privacy':
        return <PrivacyScreen policyUrl={env.privacyPolicyUrl} onOpenDrawer={onOpenDrawer} />;
      case 'Terms':
        return <TermsScreen termsUrl={env.termsOfServiceUrl} onOpenDrawer={onOpenDrawer} />;
      default:
        return null;
    }
  }

  return (
    <ScreenStack
      pushedRoutes={pushedRoutes}
      renderRoute={renderRoute}
      underlayAnimatedStyle={backSwipeUnderlayAnimatedStyle}
      pushedScreenAnimatedStyle={backSwipePushedScreenAnimatedStyle}
    >
      {mainScreen}
    </ScreenStack>
  );
}

const styles = StyleSheet.create({
  stack: { flex: 1 },
  pushedScreen: StyleSheet.absoluteFill,
});
