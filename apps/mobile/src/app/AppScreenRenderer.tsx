import { useAtomValue } from 'jotai';

import { env } from '../config';
import { BrowserScreen } from '../screens/BrowserScreen';
import { GitScreen } from '../screens/GitScreen';
import { MainScreen } from '../screens/MainScreen';
import { PrivacyScreen } from '../screens/PrivacyScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TermsScreen } from '../screens/TermsScreen';
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

  switch (currentScreen) {
    case 'ChatGit':
      return gitChat ? <GitScreen chat={gitChat} /> : <MainScreen />;
    case 'Settings':
      return <SettingsScreen />;
    case 'Browser':
      return <BrowserScreen />;
    case 'Privacy':
      return <PrivacyScreen policyUrl={env.privacyPolicyUrl} onOpenDrawer={onOpenDrawer} />;
    case 'Terms':
      return <TermsScreen termsUrl={env.termsOfServiceUrl} onOpenDrawer={onOpenDrawer} />;
    default:
      return <MainScreen />;
  }
}
