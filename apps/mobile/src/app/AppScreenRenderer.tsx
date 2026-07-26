import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { env } from '../config';
import { BrowserScreen } from '../screens/BrowserScreen';
import { GitCheckoutScreen } from '../screens/GitCheckoutScreen';
import { GitScreen } from '../screens/GitScreen';
import { MainScreen } from '../screens/MainScreen';
import { PrivacyScreen } from '../screens/PrivacyScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TermsScreen } from '../screens/TermsScreen';
import { WorkspacePickerScreen } from '../screens/WorkspacePickerScreen';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import { gitChatAtom } from '../state/chat/atoms';
import { drawerCommandsAtom } from '../state/drawer/atoms';
import { currentScreenAtom } from '../state/navigation/atoms';

/**
 * Stacks a screen over the chat, the way a native stack keeps the previous screen mounted.
 *
 * The workspace picker and git checkout are pushed from the chat and hand control straight back
 * to it, so unmounting the chat underneath would remount it — and MainScreen resets its screen
 * atoms on mount.
 */
function ScreenStack({ under, children }: { under: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.stack}>
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {under}
      </View>
      {children}
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

  switch (currentScreen) {
    case 'ChatGit':
      return gitChat ? <GitScreen chat={gitChat} /> : mainScreen;
    case 'Settings':
      return <SettingsScreen />;
    case 'Browser':
      return <BrowserScreen />;
    case 'WorkspacePicker':
      return (
        <ScreenStack under={mainScreen}>
          <WorkspacePickerScreen />
        </ScreenStack>
      );
    case 'GitCheckout':
      return (
        <ScreenStack under={mainScreen}>
          <GitCheckoutScreen />
        </ScreenStack>
      );
    case 'Privacy':
      return <PrivacyScreen policyUrl={env.privacyPolicyUrl} onOpenDrawer={onOpenDrawer} />;
    case 'Terms':
      return <TermsScreen termsUrl={env.termsOfServiceUrl} onOpenDrawer={onOpenDrawer} />;
    default:
      return mainScreen;
  }
}

const styles = StyleSheet.create({
  stack: { flex: 1 },
});
