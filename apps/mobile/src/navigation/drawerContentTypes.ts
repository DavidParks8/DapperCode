import type { HostBridgeApiClient } from '../api/client';
import type { WorkspaceChatLimit } from '../appSettings';
import type { HostBridgeWsClient } from '../api/ws';

export type DrawerScreen = 'Main' | 'Browser' | 'Settings' | 'Privacy' | 'Terms';

export interface DrawerContentProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  active: boolean;
  workspaceChatLimit?: WorkspaceChatLimit;
  selectedChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNavigate: (screen: DrawerScreen) => void;
  onClose?: () => void;
}