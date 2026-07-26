import { MainScreenHeaderAndWorkflow } from './MainScreenHeaderAndWorkflow';
import { MainScreenTranscriptAndAgentDetail } from './MainScreenTranscriptAndAgentDetail';
import { MainScreenWorkspaceAndGitModals } from './MainScreenWorkspaceAndGitModals';
import { MainScreenAttachmentModals } from './MainScreenAttachmentModals';
import { MainScreenApprovalAndBridgePrompts } from './MainScreenApprovalAndBridgePrompts';
import { View } from 'react-native';
import { useMainScreenStyles } from './useMainScreenStyles';
import type { MainScreenPanelCollapseCoordinatorContext, MainScreenPanelCollapseCoordinatorResult } from './mainScreenPanelCollapseCoordinator';




type MainScreenViewContext = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

export function MainScreenView({ context }: { context: MainScreenViewContext }) {
  const { styles } = useMainScreenStyles();
  return (
    <View style={styles.container}>
      <MainScreenHeaderAndWorkflow context={context} />
      <MainScreenTranscriptAndAgentDetail context={context} />
      <MainScreenWorkspaceAndGitModals context={context} />
      <MainScreenAttachmentModals context={context} />
      <MainScreenApprovalAndBridgePrompts context={context} />
    </View>
  );
}
