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
import { currentScreenAtom } from '../state/navigation/atoms';

type AnimatedViewStyle = ComponentProps<typeof Animated.View>['style'];

interface AppScreenRendererProps {
  backSwipeUnderlayAnimatedStyle?: AnimatedViewStyle;
  backSwipePushedScreenAnimatedStyle?: AnimatedViewStyle;
}

/**
 * Keeps the chat mounted underneath a pushed screen, the way a native stack does.
 *
 * The chat must stay in the same tree position whether or not a screen is pushed. If the root
 * element type changes between renders React remounts the chat, and MainScreen resets every screen
 * atom on mount, which would wipe the composer draft and any in-flight chat creation.
 */
function ScreenStack({
  children,
  pushed,
  underlayAnimatedStyle,
  pushedScreenAnimatedStyle,
}: {
  children: ReactNode;
  pushed: ReactNode;
  underlayAnimatedStyle?: AnimatedViewStyle;
  pushedScreenAnimatedStyle?: AnimatedViewStyle;
}) {
  const covered = pushed !== null;
  return (
    <View style={styles.stack}>
      <Animated.View
        style={[styles.stack, covered ? underlayAnimatedStyle : undefined]}
        pointerEvents={covered ? 'none' : 'auto'}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </Animated.View>
      {covered ? (
        <Animated.View style={[styles.pushedScreen, pushedScreenAnimatedStyle]}>
          {pushed}
        </Animated.View>
      ) : null}
    </View>
  );
}

function useOpenDrawer(): () => void {
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  return () => drawerCommands?.toggleNavigation();
}

export function AppScreenRenderer({
  backSwipeUnderlayAnimatedStyle,
  backSwipePushedScreenAnimatedStyle,
}: AppScreenRendererProps = {}) {
  const currentScreen = useAtomValue(currentScreenAtom);
  const gitChat = useAtomValue(gitChatAtom);
  const onOpenDrawer = useOpenDrawer();
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id;

  useEffect(() => {
    if (currentScreen === 'ChatGit') {
      Keyboard.dismiss();
    }
  }, [currentScreen]);

  // MainScreen still owns per-profile session state, so it is remounted per bridge profile.
  const mainScreen = <MainScreen key={activeBridgeProfileId} />;

  const pushedScreen =
    currentScreen === 'ChatGit' && gitChat ? (
      <GitScreen chat={gitChat} />
    ) : currentScreen === 'WorkspacePicker' ? (
      <WorkspacePickerScreen />
    ) : currentScreen === 'GitCheckout' ? (
      <GitCheckoutScreen />
    ) : null;

  switch (currentScreen) {
    case 'Settings':
      return <SettingsScreen />;
    case 'Browser':
      return <BrowserScreen />;
    case 'Privacy':
      return <PrivacyScreen policyUrl={env.privacyPolicyUrl} onOpenDrawer={onOpenDrawer} />;
    case 'Terms':
      return <TermsScreen termsUrl={env.termsOfServiceUrl} onOpenDrawer={onOpenDrawer} />;
    case 'ChatGit':
    case 'Main':
    case 'WorkspacePicker':
    case 'GitCheckout':
    default:
      // One shared shape for the chat and the screens pushed over it, so pushing and popping
      // never remounts the chat.
      return (
        <ScreenStack
          pushed={pushedScreen}
          underlayAnimatedStyle={
            currentScreen === 'ChatGit' ? backSwipeUnderlayAnimatedStyle : undefined
          }
          pushedScreenAnimatedStyle={
            currentScreen === 'ChatGit' ? backSwipePushedScreenAnimatedStyle : undefined
          }
        >
          {mainScreen}
        </ScreenStack>
      );
  }
}

const styles = StyleSheet.create({
  stack: { flex: 1 },
  pushedScreen: StyleSheet.absoluteFill,
});
