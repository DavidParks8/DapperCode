import { useAtomValue } from 'jotai';

import { env } from '../config';
import { BrowserScreen } from '../screens/BrowserScreen';
import { GitScreen } from '../screens/GitScreen';
import { MainScreen } from '../screens/MainScreen';
import { PrivacyScreen } from '../screens/PrivacyScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TermsScreen } from '../screens/TermsScreen';
import { activeBridgeProfileAtom } from '../state/bridge/atoms';
import { gitChatAtom } from '../state/chat/atoms';
import { drawerCommandsAtom } from '../state/drawer/atoms';
import { currentScreenAtom } from '../state/navigation/atoms';

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
    case 'Privacy':
      return <PrivacyScreen policyUrl={env.privacyPolicyUrl} onOpenDrawer={onOpenDrawer} />;
    case 'Terms':
      return <TermsScreen termsUrl={env.termsOfServiceUrl} onOpenDrawer={onOpenDrawer} />;
    default:
      return mainScreen;
  }
}
