import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

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

/**
 * Keeps the chat mounted underneath a pushed screen, the way a native stack does.
 *
 * The chat must stay in the same tree position whether or not a screen is pushed. If the root
 * element type changes between renders React remounts the chat, and MainScreen resets every screen
 * atom on mount, which would wipe the composer draft and any in-flight chat creation.
 */
function ScreenStack({ children, pushed }: { children: ReactNode; pushed: ReactNode }) {
  const covered = pushed !== null;
  return (
    <View style={styles.stack}>
      <View
        style={styles.stack}
        pointerEvents={covered ? 'none' : 'auto'}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {covered ? <View style={StyleSheet.absoluteFill}>{pushed}</View> : null}
    </View>
  );
}

function useOpenDrawer(): () => void {
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  return () => drawerCommands?.toggleNavigation();
}

export function AppScreenRenderer() {
  const currentScreen = useAtomValue(currentScreenAtom);
  const gitChat = useAtomValue(gitChatAtom);
  const onOpenDrawer = useOpenDrawer();
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id;
  // MainScreen still owns per-profile session state, so it is remounted per bridge profile.
  const mainScreen = <MainScreen key={activeBridgeProfileId} />;

  const pushedScreen =
    currentScreen === 'WorkspacePicker' ? (
      <WorkspacePickerScreen />
    ) : currentScreen === 'GitCheckout' ? (
      <GitCheckoutScreen />
    ) : null;

  switch (currentScreen) {
    case 'ChatGit':
      return gitChat ? <GitScreen chat={gitChat} /> : mainScreen;
    case 'Settings':
      return <SettingsScreen />;
    case 'Browser':
      return <BrowserScreen />;
    case 'Privacy':
      return <PrivacyScreen policyUrl={env.privacyPolicyUrl} onOpenDrawer={onOpenDrawer} />;
    case 'Terms':
      return <TermsScreen termsUrl={env.termsOfServiceUrl} onOpenDrawer={onOpenDrawer} />;
    case 'WorkspacePicker':
    case 'GitCheckout':
      return <ScreenStack pushed={pushedScreen}>{mainScreen}</ScreenStack>;
    default:
      return mainScreen;
  }
}

const styles = StyleSheet.create({
  stack: { flex: 1 },
});
